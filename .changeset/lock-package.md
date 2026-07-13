---
"@sozai/lock": minor
---

First release of `@sozai/lock`: a blocking cross-process file mutex for Node.js.

`withFileLock(lockPath, fn)` runs a critical section under an exclusive lock, and
`acquireFileLock(lockPath)` returns a `Disposable` handle for callers whose critical section is not
a single function. Acquisition blocks with jittered backoff and **throws** `TimeoutInterruption`
when it cannot be taken within `timeout` (default 10s) — it never falls through and runs the
section unlocked.

The lock is claimed by `link()`-ing a fully-written temp file into place, so no racer can ever read
a half-written lockfile and conclude nobody holds it. Reap and release are inode-guarded: no
process can unlink a lockfile other than the one it classified.

Stale-lock recovery proves liveness rather than assuming it. A holder on this host, from this boot,
whose pid still answers `kill(pid, 0)` is never reaped — no matter how long it holds the lock,
because a critical section can legitimately block the event loop for minutes (a synchronous keyring
call, an OS keychain prompt). The `staleTimeout` TTL (default 60s) applies only where the pid means
nothing: a foreign host, a different boot, or a corrupt record.

Node-only, and `lockPath` must be on a local filesystem — `link()` atomicity is not guaranteed on
NFS.
