# lock — cross-process file mutex

**Status:** complete · 2026-07-13
**Package:** `@sozai/lock` (minor, first release `0.1.0`)
**Source:** requested by kokuin (`../../../../kokuin/docs/superpowers/specs/` — keystore contract
& adversarial tests), not audit-derived. Prior art: `../../../../tejika/packages/process/src/lock.ts`.

## Goal

`@kokuin/node` stores private keys via `@napi-rs/keyring`, whose write API is an unconditional
upsert — no compare-and-swap, no create-if-absent. `provideAsync` is a read-if-absent / generate /
write sequence that is not atomic across processes: two processes racing on the same fresh keyID
both see an empty slot, both generate, both write, and the loser is left signing with a key that is
no longer in the keychain. `@kokuin/electron` has the identical bug over `electron-store`. kokuin
cannot depend on `@tejika/process` (`kokuin → @tejika/process → @enkaku → kokuin` is a cycle), so
mutual exclusion had to come from sozai, the one layer kokuin legally depends on.

`@sozai/lock` ships one primitive — a blocking, cross-process file mutex — Node-only, one
dependency (`@sozai/async`).

## What was built

```ts
export type FileLockOptions = {
  timeout?: number        // default 10_000 — bounds acquisition only, never the critical section
  staleTimeout?: number   // default 60_000 — TTL for a holder whose liveness can't be proven
  retryDelay?: number     // default 10 — initial backoff, ms
  maxRetryDelay?: number  // default 250 — backoff ceiling, ms
  signal?: AbortSignal    // aborts a pending acquisition only
}

export type FileLock = Disposable & {
  readonly path: string
  release(): void  // idempotent, inode-guarded
}

export function acquireFileLock(lockPath: string, options?: FileLockOptions): Promise<FileLock>
export function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T>

export type LockRecord = {
  pid: number
  hostname: string
  bootAt: number      // host boot time (ms since epoch) — gates the pid probe across a reboot
  startedAt: number   // wall-clock claim time — ages a FOREIGN-host holder
  uptimeAt: number    // os.uptime() (ms) at claim time — ages a SAME-host holder, monotonically
}

export { TimeoutInterruption } from '@sozai/async'
```

`LockEntry` (a `LockRecord` plus the inode and mtime it was read from) is internal only — it is not
re-exported from `index.ts`; `liveness.ts` is the sole consumer outside `file.ts`.

98 tests: unit coverage per module (`record`, `file`, `liveness`, `queue`, `lock`) plus
`test/cross-process.test.ts` (forks real child processes to prove mutual exclusion — nothing
in-process can, since every in-process test shares one pid and one fs cache) and
`test/cross-process-reap.test.ts` (a genuinely SIGKILLed holder is reaped without waiting out the
TTL, and the exit hook removes a lockfile left behind by `process.exit()`). Both cross-process
claims were verified to go red when the mechanism they pin was stubbed out.

## Design decisions

- **The claim is `linkSync()` from a fully-written temp file, never create-then-write.** A
  create-then-write claim leaves a zero-byte file visible for an instant, and a racer reading it
  there parses nothing, concludes "nobody home," and reaps the winner's fresh lock — the exact
  check-then-act this design exists to remove.
- **Liveness is proven, never assumed:** same hostname + same `bootAt` + `process.kill(pid, 0)`
  not throwing `ESRCH`. A provably-live holder is never reaped, however long it holds. This is
  what rules out a heartbeat: `@napi-rs/keyring` is synchronous and blocks the event loop, and the
  macOS keychain can put a user prompt in front of the read, so a holder can legitimately sit in
  its critical section for minutes with a starved event loop. A heartbeat timer would never fire,
  and a TTL-based reaper would delete a live lock and hand a second process the same critical
  section.
- **`staleTimeout` applies only where the pid means nothing:** a foreign host, a different boot, or
  a record too corrupt to identify a holder (dated then by the file's own mtime, not the record).
- **`bootAt` exists because pid-probing across a reboot is a lie.** pids recycle, `lockPath` is
  persistent (kokuin puts it beside app data), and a recycled pid would report a live holder and
  wedge the lock forever. A boot mismatch downgrades the holder to "unprovable" (TTL decides)
  rather than reaping it.
- **Superseded: "clock skew costs latency, never mutual exclusion."** That was this document's
  original claim about `bootAt` and the TTL, and the final-review pass found it false: a forward
  wall-clock step larger than `staleTimeout`, while a lock was genuinely held, pushed the record's
  `bootAt` out of `BOOT_TOLERANCE_MS` (→ "unprovable") *and* pushed `now - startedAt` past the TTL —
  one clock step, both halves of the reap condition, from a single stale-vs-alive check. It could
  reap a live holder, i.e. break mutual exclusion, not just add latency. The fix
  (`fdc2019`) adds `uptimeAt` (`os.uptime()` at claim time) to the record and ages a **same-host**
  unprovable holder by the monotonic delta `getUptimeAt() - record.uptimeAt` instead of by wall
  clock — no NTP correction, VM resume, laptop wake, or bad RTC can step `os.uptime()`, so that age
  can no longer be inflated by a clock jump. A *negative* age (this host's uptime is now below the
  record's) signals that the host rebooted since the record was written, and is stale at once when
  the wall clock corroborates it (`now - startedAt > staleTimeout`, added in the final pass:
  `os.uptime()` is **not** portably monotonic — darwin's `uv_uptime` is `time(NULL) - kern.boottime`
  and the kernel adjusts `kern.boottime` on clock and sleep events, so a forward bump can hand a
  *live* holder a boot mismatch and a negative age together. A reboot always leaves real downtime,
  so requiring corroboration costs a real reboot nothing).
- **Not "a strictly stronger reboot signal than `bootAt`" — that earlier claim was false, and is
  retracted here.** The `uptimeAt` rule is a *trade*: a holder that claimed the lock 3s into a boot,
  followed by a reboot, leaves a record whose `uptimeAt` sits *below* the new boot's current uptime →
  a small positive age → not stale → respected for the full `staleTimeout`. The wall-clock rule it
  replaced reaped that record immediately. It is bounded by the TTL, so it is reap **latency**, not
  an exclusion hole, and the trade is inherent: from the wall clock alone a reboot and a forward
  clock step are indistinguishable, which is precisely why the wall clock had to go.
- The residual limit is real and is documented rather than glossed over: a **foreign-host** record
  still has no uptime we can read, so it is still aged by wall clock against `startedAt` (or the
  file's mtime for a corrupt record) — a clock step on either machine can still expire it early.
  This is on top of, not instead of, "cross-host locking is unsupported."
- **`timeout: 0` is a documented try-lock, not merely "a short timeout."** One attempt, no waiting:
  the queue reports whether the path is free **synchronously**, from a count of un-released slots
  taken at entry, and the retry/backoff branch throws immediately instead of sleeping. (The first
  implementation raced the queue turn against an already-resolved sentinel; the final pass found
  that broken — a chain link resolved with a thenable stays pending two extra microtask hops, so a
  free slot read as busy and a try-lock on a lock nobody held threw. Fixed in the final pass; the
  verdict is now exact and depends on no microtask timing at all.) It rejects — `acquireFileLock` is
  `async` — in the same tick, before any timer can fire; it does not throw synchronously. It still reaps a stale holder and re-claims at once — reaping is not waiting — and it
  skips the pre-reap jitter below, accepting the (crash-only, already-rare) TOCTOU odds rather than
  spending time it was told not to spend.
- **Reap and release are both inode-guarded, but the guard is not a proof.** An unguarded unlink
  removes whatever sits at the path *right now*, which — after any `await` — may be a different
  holder's live lock. `readLockEntry` reads the record, inode, and mtime through one descriptor so
  the three can't straddle a replacement; reap and release both present the inode read at
  classification time. But `reapLockFile` is `statSync` then `rmSync` — two syscalls — so a window
  remains *during the call*: two waiters that classify the same stale inode in lockstep can
  interleave such that the second unlinks the first's freshly-claimed live lock. POSIX has no
  unlink-if-inode, so no sequence of name operations closes this; `acquireFileLock` now awaits a
  jitter uniform in `[0, retryDelay)` before reaping (skipped for a try-lock), which desynchronizes
  waiters released by the same stale lock so they don't step through the window together. That is a
  probabilistic mitigation of a rare, crash-only path, not a proof — it is the one place this
  package's exclusion is not absolute, and the source comments say so rather than implying
  otherwise.
- **The exit-cleanup hook covers less than "a clean exit."** It runs on `process.exit()` and a
  natural event-loop drain, and nothing else: a default-handled `SIGINT`/`SIGTERM` terminates Node
  without emitting `'exit'`, so the hook does not run there (SIGKILL never could). This is
  deliberate, not an oversight — installing signal handlers here would silently change the host
  process's termination behavior for a library concern. It is also benign: a signalled process's
  pid is gone, so the next waiter's liveness probe reports `'dead'` and reaps at once, with no TTL
  wait. Now covered by `test/cross-process-reap.test.ts` (see below).
- **I/O errors surface, they are not folded into "no lock present."** `readLockEntry` originally
  treated any read failure the same as `ENOENT`. The final-review pass found this made a
  misconfigured `lockPath` (a directory sitting there, or an unreadable file) indistinguishable from
  a lock genuinely held by someone else: the acquire loop backed off and eventually threw
  `TimeoutInterruption`, blaming a phantom holder for what was really `EISDIR`/`EACCES`. Only
  `ENOENT` now yields the all-null entry; every other error is thrown immediately. A consumer's
  `catch` must therefore handle real filesystem errors, not only `TimeoutInterruption`.
- **`retryDelay` is a backoff ceiling, not the realized first delay.** The backoff is halved and
  jittered, so the first wait is uniform in `[retryDelay / 2, retryDelay)` — `[5, 10)` at the
  default. The same value also bounds the pre-reap jitter above.
- **Acquiring a lock creates `lockPath`'s parent directory tree**
  (`mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })`) — an undocumented-until-now
  side effect: callers do not need to pre-create the directory a lockfile lives in.
- **An in-process FIFO queue (`enterQueue`) serializes same-process callers before any filesystem
  work.** Without it, two callers in one process fight through the filesystem, and the second
  reads a lockfile whose pid is *its own live pid* — it can never reap it, so it simply polls
  until the first releases. Correct, but it pays backoff latency for the most common case in an
  app, and it's the case `@kokuin/node`'s hand-rolled `#provideLock` chain existed for; kokuin can
  now drop that chain.
- **Acquisition throws on timeout and never falls through to run the critical section unlocked.**
  `withFileLock`'s `fn` is not called if the lock can't be taken within `timeout`; the timeout
  bounds acquisition only, never `fn` once it's running.
- **`TimeoutInterruption` is re-exported** from `@sozai/lock` (sourced from `@sozai/async`) so a
  consumer can catch what the package throws without depending on `@sozai/async` directly, and
  without `instanceof` breaking across duplicate installs.
- **Mutual exclusion is proven by a forked-children test** (`test/cross-process.test.ts`): N
  children append `enter`/`exit` markers to a witness file inside the critical section, and the
  test asserts they never interleave. It was verified to go red when the lock was stubbed out.
  `test/cross-process-reap.test.ts` (added in the final-review pass) additionally proves recovery
  from a genuinely **`SIGKILL`ed** holder — a child is killed while holding the lock, and the parent
  acquires well within the `staleTimeout` TTL, which is only possible if the dead-pid probe reaped
  it, not the TTL — and that the exit hook removes the lockfile after a clean `process.exit()`. Both
  were verified to go red when the mechanism under test was stubbed out (`checkLiveness` forced to
  `'alive'` for the SIGKILL case).
- **Node-only, and `lockPath` must be on a local filesystem** — `link()` atomicity is not
  guaranteed on NFS. Not reentrant: acquiring the same path twice in one process without
  releasing deadlocks until the timeout throws.

## Rejected

- **Heartbeat / TTL-refresh staleness.** A holder that must periodically touch the lockfile to
  stay "alive" fails exactly when the critical section blocks the event loop for a while — a
  synchronous keyring call or an OS keychain prompt — which is the normal case this package
  guards, not an edge case.
- **TTL-only staleness with no pid probe.** Would reap a live holder that has simply held the
  lock longer than the TTL; the whole point is that holding time and liveness are unrelated.
- **A `maxHoldTime` outer bound, even on a provably-live holder.** `bootAt` already removes the
  wedge case (recycled pid after reboot) that would motivate an outer bound, and adding one would
  re-open the reap-a-live-holder hole the rest of the design closes.
- **A general `Mutex` interface with an in-memory backend.** Both known consumers need exactly a
  file mutex; every extra symbol is permanent after the freeze, and the package is deliberately
  named for the domain (like every sibling), not for an abstraction.
- **Shared/read locks and lock upgrade.** Out of scope — no consumer needs anything but exclusive.

## Follow-ups

- **Rebase `@tejika/process` onto this primitive**, so there is one implementation in the stack
  rather than two. The generic core is the atomic claim, the inode-guarded reap, and the record
  validation; tejika's daemon semantics — `LockRecord.socketPath`, the `ready` flag, the
  non-blocking `ClaimResult` conflict-reporting shape — are daemon-lifecycle concerns and must
  survive the extraction, layered above `@sozai/lock`.
- **kokuin consumes it:** `NodeKeyStore.open(service, { lockPath })` and the same option on
  `@kokuin/electron` — opt-in, coarse one-lock-per-store, not per-keyID. A per-keyID lockfile
  would derive a filename from an attacker-influenced `keyID` (path traversal), and
  `provideAsync` is a once-per-identity operation, so serializing across keyIDs costs nothing.
  kokuin drops its in-process `#provideLock` chain in the same change.
- ~~**Test-coverage gap:** the process-exit hook in `src/lock.ts` ... has no test.~~ Closed in the
  final-review pass: `test/cross-process-reap.test.ts` runs a real child process that acquires the
  lock and calls `process.exit(0)` without releasing, then asserts the lockfile is gone. The same
  file also adds the `SIGKILL` recovery test noted above.
