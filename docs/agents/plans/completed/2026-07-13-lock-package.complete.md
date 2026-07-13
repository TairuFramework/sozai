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
  bootID: string | null  // OS boot identity — GATES the pid probe; null where unreadable
  bootAt: number         // wall-clock-derived boot time — FALLBACK gate, only where bootID is null
  startedAt: number      // wall-clock claim time — ages a FOREIGN-host holder
  uptimeAt: number       // os.uptime() (ms) at claim time — ages a SAME-host holder, monotonically
}

export { TimeoutInterruption } from '@sozai/async'
```

`LockEntry` (a `LockRecord` plus the inode and mtime it was read from) is internal only — it is not
re-exported from `index.ts`; `liveness.ts` is the sole consumer outside `file.ts`.

150 tests (149 + one platform-gated skip): unit coverage per module (`record`, `boot-id`, `file`,
`liveness`, `queue`, `lock`) plus
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
- **Liveness is proven, never assumed:** same **boot ID** + same pid namespace (which on linux, and
  on the no-boot-ID fallback, means the same hostname — see below) + `process.kill(pid, 0)` not
  throwing `ESRCH`. A provably-live holder is never reaped, however long it holds. This is
  what rules out a heartbeat: `@napi-rs/keyring` is synchronous and blocks the event loop, and the
  macOS keychain can put a user prompt in front of the read, so a holder can legitimately sit in
  its critical section for minutes with a starved event loop. A heartbeat timer would never fire,
  and a TTL-based reaper would delete a live lock and hand a second process the same critical
  section.
- **`staleTimeout` applies only where the pid means nothing:** a foreign host, a different boot, or
  a record too corrupt to identify a holder (dated then by the file's own mtime, not the record).
- **Boot identity gates the pid probe, because pid-probing across a reboot is a lie.** pids recycle,
  `lockPath` is persistent (kokuin puts it beside app data), and a recycled pid would report a live
  holder and wedge the lock forever. A boot mismatch downgrades the holder to "unprovable" (TTL
  decides) rather than reaping it.
- **Retracted: boot identity from the wall clock (`bootAt`).** The original design decided "same
  boot" by comparing `bootAt` (`Date.now() - os.uptime() * 1000`) within a 30s tolerance. The final
  review pass proved that broken against the real code — our own live pid, our own hostname, a
  genuine 61s hold, plus a +300s wall-clock step ⇒ `liveness: 'unknown'`, a correct (uninflated)
  monotonic age of 61s, a pid that was alive the whole time, and `isStale: true`. **The live holder
  was reaped.** It is not fixable by tuning the tolerance, because the tolerance trades one failure
  against the other with no safe side:
  - **tight** ⇒ a forward step (NTP, laptop sleep/wake, VM resume) moves our `bootAt` away from a
    live holder's, its pid is never probed, and the TTL reaps it — two processes in the critical
    section. And this is the package's *own motivating scenario*: a macOS keychain prompt holds the
    section for minutes, and sleep/wake supplies the step.
  - **wide** ⇒ a reboot inside the tolerance still "matches", so a dead holder's recycled pid is
    probed, answers as somebody else, and the lock wedges forever.
  - **What replaced it:** `LockRecord.bootID`, an OS-provided boot identity that no clock can move —
    `/proc/sys/kernel/random/boot_id` (linux), `sysctl -n kern.bootsessionuuid` (darwin), `null`
    elsewhere or where the source will not answer at all. Read and cached per process (see the retry
    below), and it never throws: a lock claim must not fail because a boot ID could not be read. When
    both sides have one they are
    compared **exactly** — equal ⇒ same boot ⇒ probe the pid (so a live holder is *always* probed
    and *always* found alive, whatever the clock did); different ⇒ `unknown`, pid never probed (so a
    recycled pid is never mistaken for a holder and the TTL reaps). This closes both halves at once.
  - **The residual, stated honestly — the fallback path is NOT safe, and it is NOT only a clock
    story.** Where either side has no boot ID (an unsupported platform, or a record written by a
    process whose read failed) the `bootAt` tolerance is still the fallback — the only reason
    `bootAt` remains on the record — and the hostname is once again the only machine identity there
    is. **Two** events therefore cost a live holder its liveness *proof*, and with it **its lock**,
    as soon as its true monotonic age passes `staleTimeout`. Both measured against the real code:
    - a **clock step** larger than the tolerance: same host, `bootID: null`, live pid, 90s hold, 60s
      TTL, +31s step ⇒ `liveness: 'unknown'`, `isStale: true`;
    - a **hostname change, with NO clock step at all**: darwin, `bootID: null` on either side, a DHCP
      rename, live pid, 90s hold, 60s TTL, `bootAt` exactly ours ⇒ `liveness: 'unknown'`,
      `probed: false`, `isStale: true`. Every earlier draft of this document framed the fallback's
      danger as "a forward clock step larger than the tolerance"; **that framing was incomplete and
      is retracted.** The rename is the very event the darwin boot-ID rule was introduced to survive,
      and on the fallback it is not survived. Sharper still: darwin's boot ID comes from an **exec**,
      so a macOS App Sandbox or hardened runtime that blocks spawning `/usr/sbin/sysctl` puts a
      process on this path *permanently* — and macOS + laptop + DHCP-renamed is precisely the
      population that then has no protection against the rename.

    An earlier version also claimed the step "no longer costs it the lock" there; false, and
    retracted. What `uptimeAt` buys on this path is narrower: it removes the *inflated* age, so a
    holder *younger* than the TTL is no longer reaped by the clock step alone — it does nothing for a
    holder that has held longer than `staleTimeout`, which is exactly the minutes-long
    macOS-keychain-prompt hold this package exists for. "A clock step cannot reap a live holder" is a
    **linux/darwin, boot-ID-readable** guarantee, not a universal one. Both reaps are pinned by tests
    that assert them rather than assuming them away.
  - **A failed boot-ID read is retried, never cached as a value — and the retry is spent where it
    is worth something.** `getBootID` originally cached `null` whatever produced it, so one `EMFILE`
    at the first claim — or a sandbox that denied the `sysctl` exec once — silently downgraded the
    process to the clock-step-vulnerable fallback for its whole life, on a platform whose docs promise
    the guarantee. `readBootID` returns a tri-state (`ok` / `unsupported` / `failed`): an unsupported
    platform settles on `null` at once (no retry can change what the platform does not publish, and
    re-reading would put a failing read in the hot acquisition loop), and an EMPTY read is a
    *failure*, never an empty boot ID that could compare equal to another empty one. Still
    non-throwing: a lock claim must not fail because a boot ID could not be read.

    The retry's *placement* was fixed after a later review, and the fix has two halves:
    - **The budget is spent BEFORE the first caller is answered.** It used to be spent on the call
      *after* the failure, which paid off after the damage: `createLockRecord` had already written
      `bootID: null` onto the record, where it is **frozen for the life of the hold** — so that hold,
      and every waiter evaluating it, stayed on the unsafe fallback for the lock's entire life, long
      after the process itself had recovered a real boot ID. `getBootID` now exhausts the budget
      within the first call, so no caller ever sees a `null` the source has already recanted.
    - **The budget is per ACQUISITION, not per process** (`retryBootIDRead`, called by
      `acquireFileLock` before it builds its record). Both reads of one budget land in the same tick,
      so on their own they survive a source that fails *non-deterministically* and nothing more — an
      `EMFILE` storm or a sandbox denial that outlasts a tick fails both, and the old lifetime budget
      then downgraded the process **for life** over one unlucky claim. (The comment claiming the
      retry survived "an `EMFILE` at the first claim" was true only of one that cleared within a
      tick; corrected.) Reset per acquisition, the same storm costs a single hold, and the next lock
      the caller takes — the only real time separation a synchronous path has — reads the source
      again. A permanently-failing source is still bounded at two reads per acquisition, never a
      per-turn `sysctl` spawn.
  - **One read of our own boot ID per liveness decision.** `checkLiveness` called `getBootID()`
    directly *and* again inside `isSameBoot`, and across the retry window the two could disagree
    (`null` once, a real boot ID once) — one decision made from two different boots. Safe only by
    accident (`&&` short-circuited the second read, and `createLockRecord` absorbed the first), and a
    live-holder reap waiting for a refactor. The value is now read once per `checkLiveness` and
    threaded through, pinned by tests that count the reads.
- **The hostname is checked AFTER the boot ID, and the platforms differ — deliberately.** Testing
  the hostname *first* reaped a live, boot-ID-matched holder running under our own eyes whenever the
  host was renamed mid-hold — and macOS renames the host from DHCP when a laptop joins a network,
  i.e. on the very sleep/wake event this package is written for. The hostname is a *machine*
  identity, not a boot identity, and a mutable one, so it is consulted only where it is load-bearing:
  - **darwin:** a matching `kern.bootsessionuuid` proves the same machine *and* the same pid
    namespace (macOS has no pid namespaces, and a container "on a Mac" is really a linux VM — it
    reports platform `linux` and reads that VM's own `boot_id`). So it authorizes the pid probe
    **regardless of the hostname**.
  - **linux:** it does **not**. Containers on one host *share* `/proc/sys/kernel/random/boot_id` but
    have *separate* pid namespaces, so a boot-ID match there can be two different containers, and
    probing the recorded pid would probe a stranger's process. The hostname is the only discriminator
    available, so it **stays** on that path. Do not "simplify" the linux branch into the darwin one.
    But it discriminates only *by default*, and the docs may not claim more: `--hostname`,
    `--uts=host` or `--net=host` gives two containers the same hostname, the same `boot_id` and
    separate pid namespaces at once, and the pid is then probed across namespaces — a live holder in
    container A reads `'dead'` in B and is reaped immediately, and a dead holder's pid 1 matches B's
    init and wedges the lock. Both directions are real, neither is detectable from inside, and
    neither is fixed here: **sharing a `lockPath` across containers is unsupported**, for the same
    reason sharing one across hosts is.
  - **fallback (`bootID: null`):** the hostname is the only machine identity there is. Unchanged.
- **Superseded: "clock skew costs latency, never mutual exclusion."** This document's original claim
  about `bootAt` and the TTL, and false: one forward wall-clock step supplied *both* halves of the
  reap condition — the boot mismatch above (→ "unprovable") *and* an inflated `now - startedAt` past
  the TTL. The first fix (`fdc2019`) added `uptimeAt` (`os.uptime()` at claim time) and ages a
  **same-host** unprovable holder by the monotonic delta `getUptimeAt() - record.uptimeAt`, so no
  NTP correction, VM resume, laptop wake, or bad RTC can *inflate* that age. That fix was necessary
  but **not sufficient**, and the plan record said otherwise for a while: it stopped a clock step
  from inflating the age, and did nothing at all about the step destroying the liveness *proof* —
  which is the hole `bootID` (above) actually closes.
- **A negative age is a reboot SIGNAL, not a reboot proof, and is corroborated before anything is
  reaped.** `os.uptime()` is **not** portably monotonic — darwin's `uv_uptime` is
  `time(NULL) - kern.boottime` and the kernel adjusts `kern.boottime` on clock and sleep events, so
  a forward bump can hand a *live* holder a negative age. Corroboration is *either* a claim older
  than the TTL (`now - startedAt > staleTimeout`) *or* a claim dated in the **future**
  (`now < record.startedAt`). The second is not optional: on a host whose clock runs *backwards*
  past the record — a bad RTC on a Pi, a container booting to 1970 before NTP lands —
  `now - startedAt` is permanently negative, so the first can never fire and a genuinely-dead
  post-reboot holder is **never reaped**: the lock wedges forever, held by nobody. A future-dated
  claim is corroboration a live holder cannot manufacture.
- **Retracted: "a reboot always has real downtime, so corroboration costs a real reboot nothing."**
  False for a *fast* reboot — a container restart or a kexec, seconds of downtime — where hold +
  downtime + the new boot's uptime is still under the TTL: the negative age is there, but the wall
  clock cannot corroborate it yet, so the record waits the TTL out. The honest statement is that
  **reboot recovery is TTL-bounded in every case**, and there are two such cases: the fast reboot
  just described, and a holder that claimed the lock a few seconds into a boot (whose `uptimeAt`
  sits *below* the new boot's current uptime → a small positive age → no reboot signal at all).
  Both are reap **latency**, bounded by the TTL, never an exclusion hole and never a wedge — and
  both are now pinned by tests rather than assumed away.
- The residual limit is real and is documented rather than glossed over: a **foreign-host** record
  still has no uptime we can read, so it is still aged by wall clock against `startedAt` (or the
  file's mtime for a corrupt record) — a clock step on either machine can still expire it early.
  The mirror image is equally true and was under-documented: a **future-dated foreign record is
  respected until our own clock catches up to its `startedAt`**, so that wait is bounded by the
  *peer's skew*, not by the TTL. Deliberate — two hosts' clocks legitimately disagree, and a foreign
  record carries no reboot signal to corroborate reaping it early — but a consumer sees a lock held
  for longer than `staleTimeout` and must not be surprised. All of this is on top of, not instead
  of, "cross-host locking is unsupported."
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
- **A `maxHoldTime` outer bound, even on a provably-live holder.** Adding one would re-open the
  reap-a-live-holder hole the rest of the design closes: a live holder would lose its lock for
  holding it too long, which is the exact bug this package exists to prevent (a keychain prompt can
  legitimately hold the section for minutes). Rejected on those grounds — **not** because the wedge
  case it would bound is gone. An earlier version of this document said `bootID` "already removes
  the wedge case", which is true only of the **cross-reboot** recycle. The honest statement:
  - **A pid recycled *within* the same boot still wedges the lock, forever.** A `SIGKILL`ed holder
    whose lockfile outlives the pid space wrapping around to that number again probes `'alive'` →
    never stale → unrecoverable without a reboot or a manual `rm`. Same boot, so the boot ID matches
    and proves nothing about the *process*.
  - It is an **availability** failure, not an exclusion failure: it fails in the safe direction and
    never lets two processes into the critical section — where `maxHoldTime` would fail in the
    unsafe one. That is the trade, made knowingly, and it is documented in the README and in
    `docs/reference/runtime.md` rather than claimed away.
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
