# @sozai/lock

Cross-process file mutex. **Node.js only.**

## Installation

```sh
npm install @sozai/lock
```

## Usage

```ts
import { withFileLock } from '@sozai/lock'

const key = await withFileLock(`${dataDir}/keystore.lock`, async () => {
  const existing = await store.get(keyID)
  return existing ?? (await store.set(keyID, await generateKey()))
})
```

`lockPath`'s parent directory is created if it does not exist (`mkdirSync(..., { recursive: true,
mode: 0o700 })`) — no need to pre-create the directory the lockfile lives in.

### Try-lock

`timeout: 0` is a deterministic try-lock: one attempt, no waiting. It may still reap a stale holder
and re-claim immediately (reaping is not waiting), but it never backs off and never queues behind a
same-process caller — any live contention throws `TimeoutInterruption` synchronously.

```ts
import { acquireFileLock, TimeoutInterruption } from '@sozai/lock'

try {
  using lock = await acquireFileLock(lockPath, { timeout: 0 })
  // got it immediately
} catch (err) {
  if (err instanceof TimeoutInterruption) {
    // someone else holds it right now
  }
}
```

## Constraints

- `lockPath` must be on a **local filesystem**. `link()` atomicity is not guaranteed on NFS.
- Acquisition is bounded by `timeout` (default 10s) and **throws** when it expires — the critical
  section never runs unlocked.
- `timeout` bounds acquisition only: once the lock is held, `fn` runs to completion however long it
  takes. A caller that needs to bound the critical section itself must do so.
- Not reentrant: acquiring the same path twice in one process, without releasing, deadlocks until
  the timeout fires.
- `retryDelay` is a backoff **ceiling**, not the realized first delay: the backoff is halved and
  jittered, so the first wait is uniform in `[retryDelay / 2, retryDelay)` at the default (`[5,
  10)`).
- Acquisition can reject with a real filesystem error (e.g. `EACCES`, `EISDIR`) when `lockPath` is
  misconfigured — a directory sitting at the path, or an unreadable file — instead of timing out
  and misreporting it as a held lock. A caller's `catch` should not assume every rejection is
  `TimeoutInterruption`.
- Stale-holder recovery is aged monotonically (`os.uptime()`) for a holder on this same host, so a
  forward wall-clock step cannot reap a live one. A holder on another host is still aged by wall
  clock — there is no way to read another host's uptime — so a clock step there (or here, while
  comparing to it) can still expire its record early. Cross-host locking is unsupported for this
  reason among others.
- Reaping a stale lock is inode-guarded but not provably atomic: `statSync` then `rmSync` is two
  syscalls, and two waiters that classify the same stale lock in the same instant can — in a rare,
  crash-only interleaving — have one waiter unlink the other's freshly-claimed live lock. A jitter
  before reaping desynchronizes waiters released together and makes this vanishingly unlikely, but
  POSIX has no unlink-if-inode primitive, so it is not eliminated. This is the one place this
  package's exclusion is probabilistic rather than absolute.
- The process-exit cleanup hook only runs on `process.exit()` or a natural event-loop drain — a
  default-handled `SIGINT`/`SIGTERM` terminates Node without emitting `'exit'`, so a lock held
  across one of those is not released by this hook. This is benign: the process is gone, so the
  next waiter's liveness probe reports it dead and reaps the lockfile immediately, with no TTL wait.
