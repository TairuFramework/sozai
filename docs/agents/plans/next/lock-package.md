# New package — `@sozai/lock` (cross-process file mutex)

**Status:** designed · requested by kokuin · blocks `kokuin` keystore-contract branch
**Requested from:** `../../../../kokuin/docs/superpowers/specs/` (keystore contract & adversarial tests)
**Prior art:** `../../../../tejika/packages/process/src/lock.ts`

## Why

`@kokuin/node` stores private keys in the OS keychain via `@napi-rs/keyring`, whose write
API is an **unconditional upsert** — no compare-and-swap, no create-if-absent. Its
`provideAsync` is therefore a read-if-absent / generate / write sequence that is not atomic
across processes. `packages/node/src/entry.ts:13-15` concedes this in a comment: the
`#provideLock` promise chain serializes callers *in-process* only.

Two processes calling `provideAsync` on the same fresh keyID both observe an empty slot,
both generate, both write. Last writer wins, and the losing process is left holding a key
that is no longer in the keychain — it signs with a DID nobody can resolve. Silent key loss.

No lock-free scheme on top of an unconditional-upsert store is sound. Read-after-write
reconciliation still diverges:

```
P1 write(k1) → P1 read → sees k1, keeps k1
                          P2 write(k2) → P2 read → sees k2, keeps k2
store holds k2; P1 is still signing with orphaned k1
```

Mutual exclusion has to come from outside the store. `@kokuin/electron` has the same bug
(`electron-store` is a plain JSON file; two app instances race identically), so there are
two consumers in kokuin alone.

## Why sozai

kokuin depends downward on sozai, so this is the only layer it can legally consume from.
It cannot use `@tejika/process`: that package depends on `@enkaku/*`, and `@enkaku` depends
on kokuin — `kokuin → @tejika/process → @enkaku → kokuin` is a cycle. Tejika also sits
*above* enkaku, so kokuin reaching up into it inverts the layering regardless.

A file mutex is low-altitude raw material. Node-only is fine here; `runtime-expo` is
precedent for a platform-specific package in this repo.

---

# Design

**Package:** `@sozai/lock` — Node-only, one dependency (`@sozai/async`, `workspace:^`, as
`stream` and `execution` already do).

The package is named for the domain, like every sibling (`async`, `codec`, `flow`, `patch`,
`result`, `stream`); the exports name the mechanism. It ships one primitive: a blocking,
cross-process file mutex. It is *not* a general mutex abstraction — no in-memory backend, no
`Mutex` interface, no browser build. Both known consumers need exactly a file mutex, and
every extra symbol is permanent after the freeze.

## Public surface

```ts
export type FileLockOptions = {
  /** Acquire deadline in ms. Covers acquisition ONLY, never the critical section. Default 10_000. */
  timeout?: number
  /** Age in ms after which a holder whose liveness cannot be proven is stale. Default 60_000. */
  staleTimeout?: number
  /** Initial retry backoff in ms. Default 10. */
  retryDelay?: number
  /** Retry backoff cap in ms. Default 250. */
  maxRetryDelay?: number
  /** Aborts a pending acquisition. Has no effect once the lock is held. */
  signal?: AbortSignal
}

export type FileLock = Disposable & {
  readonly path: string
  /** Unlink the lockfile, but only while it still holds the inode we linked. Idempotent. */
  release(): void
}

export function acquireFileLock(lockPath: string, options?: FileLockOptions): Promise<FileLock>

export function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T>
```

`withFileLock` is `acquireFileLock` plus `try`/`finally release()` — the safe path, and the
one both kokuin consumers use. `acquireFileLock` exists for callers whose critical section is
not a single function (a store held open across calls). `release()` is synchronous (`rmSync`),
so the handle is a plain `Disposable`:

```ts
using lock = await acquireFileLock(lockPath)
```

**`timeout` bounds acquisition only.** Once the lock is held, `fn` runs to completion — a
mutex that yanked the lock out from under a running critical section would be no mutex at
all. A caller that needs to bound `fn` passes its own signal into `fn`.

## The on-disk record

```ts
type LockRecord = {
  pid: number
  hostname: string
  /** Host boot time, ms since epoch: Date.now() - os.uptime() * 1000. */
  bootAt: number
  startedAt: number
}
```

Nothing else, ever. No secrets, no caller payload — key material lives in the store the lock
guards, never in the lock.

Validation on every read (`isLockRecord`), rejecting:

- non-integer `pid`, or `pid <= 0`. Non-negotiable, and the reason is tejika's: `process.kill(0, sig)`
  signals the **whole process group** (the reader included) and `kill(-1, sig)` everything the
  user may signal. A record that cannot be trusted is treated exactly like a corrupt one.
- empty or non-string `hostname`; non-finite `bootAt` / `startedAt`.

A record that fails validation, or a file that fails to parse, reads as `null` and is
classified identically to a missing file: **stale by TTL**, never live.

## Atomic claim

Straight from the prior art, and the technique is the whole design:

1. Write the record to a fresh sibling `${lockPath}.<pid>.<rand>.tmp` with `flag: 'wx'`,
   `mode: 0o600`. Capture its inode from the same descriptor.
2. `linkSync(tmp, lockPath)`. `EEXIST` ⇒ someone holds it.
3. `rm` the tmp either way — on success the lockfile is a second link to the same inode, so
   ours is redundant.

The name only ever appears **fully formed**. A create-then-write claim leaves a zero-byte file
visible for an instant; a racer that reads it there parses nothing, concludes "not running",
and reaps the winner's fresh lock — the exact check-then-act this design exists to remove.

The parent directory is created on demand (`mkdirSync(dirname, { recursive: true, mode: 0o700 })`).

On a **winning** claim — the one moment the previous holder is provably gone — sweep orphaned
`.tmp` siblings older than 10s. A SIGKILL between step 1 and step 2 leaks one forever, and a
crash-looping process quietly accumulates them. Best-effort throughout: a claim must never fail
because tidying up did.

## Liveness and staleness

Liveness is **proven**, never assumed. A holder is provably alive iff all three hold:

1. `record.hostname === os.hostname()`, and
2. `record.bootAt` is within 30s of ours (`Date.now() - os.uptime() * 1000`), and
3. `process.kill(record.pid, 0)` does not throw `ESRCH` (an `EPERM` throw means the process
   exists and belongs to another user — alive).

| Holder | Verdict |
|---|---|
| liveness proven | **held** — wait. Never reaped, no matter how long it holds. |
| same host+boot, `kill` throws `ESRCH` | **stale** — reap immediately, the pid is provably gone. |
| foreign hostname, boot mismatch, or unparseable record | **stale iff `age > staleTimeout`** — liveness is unprovable, so only the TTL can decide. |

**Why a provably-live holder is never reaped, ever.** This is the requirement that rules out
a heartbeat design. `@napi-rs/keyring` is synchronous and blocks the event loop, and on macOS
the keychain can put a **user prompt** in front of the read. A holder can therefore sit inside
its critical section for minutes with a starved event loop — a heartbeat timer would never
fire, and a TTL-based reaper would delete a live lock and hand a second process the same
critical section. Exactly the bug the package exists to prevent. So: pid probe first, TTL only
where the pid means nothing.

**Why `bootAt`.** Pid-probing across a reboot is a lie. `lockPath` will be persistent (kokuin
puts it beside app data), pids are recycled from a small space, and after a reboot the recorded
pid is very likely alive again as an unrelated process — a `kill(pid, 0)` probe says "held" and
the lock wedges **forever**. `bootAt` makes that case fall through to the TTL and recover in
`staleTimeout`. It is compared with a 30s tolerance because `os.uptime()` and `Date.now()` drift
apart under NTP; a mismatch never reaps immediately, it only downgrades the holder to
"unprovable", so clock skew costs latency and can never cost mutual exclusion.

## Reap and release — both inode-guarded

`readLockEntry(path)` returns the record **and the inode it came from**, read through a single
descriptor, so the pair cannot straddle a replacement of the file.

- **Reap** (`reapLockFile(path, expectedInode)`): refuses to unlink unless the inode still
  matches the one read when the record was classified. Not optional. An unguarded reap is an
  unlink of whatever happens to sit at the path *right now*, which — after any `await` — may be
  a different holder's live lock.
- **Release**: same guard, against the inode **we linked** at claim time. Stronger than the
  prior art's pid comparison: it also stops a process from unlinking its own second, newer
  lock. Idempotent — a second `release()` is a no-op.

Losing a reap race is not an error: the reap is skipped, the loop retries, and the winner's
lock is respected.

**Process exit.** A module-level `Set` of held `{ path, inode }` and one `process.on('exit')`
listener that inode-guard-unlinks them synchronously. This covers a clean `process.exit()` or a
default-handled SIGINT, so the next run does not pay a stale-recovery round. SIGKILL and hard
crashes are precisely what the staleness rules above are for.

## Acquire loop

```
claim → EEXIST → classify(entry) → held  ⇒ sleep(jitter(min(retryDelay * 2ⁿ, maxRetryDelay))) → retry
                                 → stale ⇒ reapLockFile(path, entry.inode)              → retry
deadline exhausted ⇒ throw
abort signalled  ⇒ reject with signal.reason
```

Backoff is exponential from `retryDelay` (10ms), capped at `maxRetryDelay` (250ms), jittered so
that N processes released simultaneously do not re-collide in lockstep.

The deadline is a `ScheduledTimeout.in(timeout)` from `@sozai/async`; its signal and the
caller's `signal` are both checked on every iteration. A timeout throws `TimeoutInterruption`
— the package mints no error taxonomy of its own, so kokuin catches what it already catches
everywhere else.

**Timeout throws; it never falls through.** `fn` is not called. Running the critical section
unlocked because the lock was contended drops the guard at exactly the moment contention is
real.

## In-process serialization

A module-level `Map<path.resolve(lockPath), Promise<void>>` chains same-process callers in
FIFO; only the head of the queue touches the filesystem. Without it, two callers in one process
fight through the filesystem — and the second reads a lockfile whose pid is *its own live pid*,
so it can never reap it and simply polls until the first releases. Correct, but it pays backoff
latency for the most common case in an app, and it is the case `@kokuin/node` hand-rolled
`#provideLock` for. With the queue, kokuin deletes that chain.

- An abort or timeout **while queued** still settles the ticket, so successors are never
  stranded behind a caller that gave up.
- The map entry is deleted when the tail settles; the map does not grow without bound.
- Keyed on `path.resolve`, not `realpath` — the lockfile need not exist yet. Two aliased paths
  (via a symlinked directory) therefore fall back to filesystem contention, which is correct,
  merely slower.
- Per-realm, like any module state: it does not span worker threads or `vm` contexts. It does
  not need to. **The file is the lock**; the queue is only a fast path.
- **Not reentrant.** A nested `withFileLock` on the same path deadlocks until the timeout
  throws, like any non-reentrant mutex. Documented.

## Constraints

- **`lockPath` must be on a local filesystem.** `link()` atomicity is not guaranteed on NFS.
  Documented in the README, the reference docs, and the option's TSDoc.
- Node-only. `runtime-expo` is the precedent for a platform-bound package in this repo.

## Testing

Unit (vitest, per-package `tsconfig.test.json`, mirroring `packages/log`):

- the claim primitive (below the in-process queue) succeeds on a free path and returns `EEXIST`
  with the holder's record + inode when the path is taken
- stale-pid record (write a record with a dead pid) ⇒ reaped, acquired
- `EPERM` holder (pid 1) ⇒ treated as alive, waits, times out
- foreign `hostname` ⇒ not reaped before `staleTimeout`, reaped after
- `bootAt` mismatch ⇒ same: TTL decides, no immediate reap
- corrupt / zero-byte / non-conforming record (`pid: 0`, `pid: -1`, missing fields) ⇒ classified
  stale by TTL, and `process.kill` is **never** called with a non-positive pid
- `reapLockFile` refuses to unlink when the inode has changed under it
- `release()` refuses to unlink a record that is not ours; second `release()` is a no-op
- timeout throws `TimeoutInterruption` **and `fn` was not called**
- abort mid-wait rejects with `signal.reason`, and the queued successor still proceeds
- orphaned `.tmp` siblings older than 10s are swept on a winning claim; fresh ones are not
- in-process FIFO ordering across concurrent `withFileLock` calls

Cross-process (the only test that proves the actual claim):

- fork N node children on one `lockPath`; each appends `enter <id>` / `exit <id>` markers to a
  witness file inside its critical section, with a randomized section duration. Assert the
  witness never interleaves — every `enter` is followed by its own `exit`. Nothing in-process
  can prove atomicity: every in-process test shares one pid and one fs cache.

## Docs and registration

`docs/reference/runtime.md` (Runtime domain) and `docs/skills/runtime.skill.md`;
`docs/skills/discover.skill.md` package count 14 → 15; package README; changeset (minor,
initial `0.1.0`); `docs/agents/architecture.md` package list.

## Out of scope

Shared/read locks, lock upgrade, cross-host coordination, `fs.watch` wakeups, an in-memory
`Mutex` interface, `maxHoldTime` (an outer bound even on a provably-live holder — `bootAt`
removes the wedge case that motivated it, and it would re-open the reap-a-live-holder hole).

## Follow-ups (filed after this lands)

- **Rebase `@tejika/process` onto this primitive**, so there is one implementation in the stack
  rather than two. The generic core is the atomic claim, the inode-guarded reap, and the record
  validation. Tejika's daemon semantics — `LockRecord.socketPath`, the `ready` flag, the
  non-blocking `ClaimResult` conflict-reporting shape — are daemon-lifecycle concerns and must
  survive the extraction intact, layered *above* `@sozai/lock`.
- **kokuin consumes it:** `NodeKeyStore.open(service, { lockPath })` and the same option on
  `@kokuin/electron` — opt-in, coarse one-lock-per-store. Not per-keyID: a per-keyID lockfile
  would derive a filename from an attacker-influenced `keyID` (path traversal), and
  `provideAsync` is a once-per-identity operation, so serializing across keyIDs costs nothing.
  kokuin drops its in-process `#provideLock` chain in the same change.
