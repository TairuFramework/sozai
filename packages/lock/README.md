# @sozai/lock

Filesystem-based cross-process mutex.

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

`acquireFileLock` returns a `Disposable` handle for critical sections that aren't a single function.
`lockPath`'s parent directory is created if missing.

### Try-lock

`timeout: 0` is a deterministic try-lock: one attempt, no waiting. Live contention rejects with
`TimeoutInterruption` in the same tick.

```ts
import { acquireFileLock, TimeoutInterruption } from '@sozai/lock'

try {
  using lock = await acquireFileLock(lockPath, { timeout: 0 })
} catch (err) {
  if (err instanceof TimeoutInterruption) {
    // someone else holds it right now
  }
}
```

## How staleness is decided

A holder is only reaped when it cannot be proven alive. Proof is the pid answering `kill(pid, 0)`,
and the pid is only trusted when the record comes from this boot — decided by an OS boot ID
(`/proc/sys/kernel/random/boot_id` on linux, `sysctl -n kern.bootsessionuuid` on darwin), not by the
clock. A proven-live holder is never stale, however long it holds: a critical section can block the
event loop for minutes (an OS keychain prompt). Everywhere else, the `staleTimeout` TTL (default
60s) applies.

## Constraints

- `lockPath` must be on a **local filesystem** — `link()` atomicity is not guaranteed on NFS — and
  must not be shared between hosts or containers.
- Acquisition is bounded by `timeout` (default 10s) and **throws** when it expires. It bounds
  acquisition only: once held, `fn` runs to completion however long it takes.
- Not reentrant: acquiring the same path twice in one process deadlocks until the timeout fires.
- Acquisition can reject with a filesystem error (`EACCES`, `EISDIR`) rather than
  `TimeoutInterruption` — don't assume every rejection is a timeout.
- `retryDelay` is a backoff **ceiling**: the first wait is uniform in `[retryDelay / 2, retryDelay)`.
- **Where no boot ID is readable, a live holder held past `staleTimeout` can be reaped** — by a
  forward clock step > 30s, or by a hostname change. That covers Windows, and any linux/darwin
  process whose boot-ID read failed (on darwin the read is an `exec`, so an App Sandbox that denies
  it strands the process here permanently).
- **A pid recycled within one boot wedges the lock** until a reboot or a manual `rm`. Availability
  failure, not an exclusion one; the deliberate price of never bounding hold time.
- Reaping a stale lock is guarded (the lockfile must still carry the record that was classified
  stale) but not atomic — the read and the unlink are separate syscalls — so a rare interleaving can
  still have one waiter unlink another's fresh lock. Jitter before reaping narrows it; POSIX has no
  unlink-if-identity, so it isn't closed.
- The exit hook runs on `process.exit()` and event-loop drain, not on a default-handled
  `SIGINT`/`SIGTERM`. Benign: the next waiter finds the pid dead and reaps immediately.
