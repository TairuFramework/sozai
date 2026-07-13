---
"@sozai/lock": minor
---

First release of `@sozai/lock`: a blocking cross-process file mutex for Node.js.

`withFileLock(lockPath, fn)` runs a critical section under an exclusive lock, and
`acquireFileLock(lockPath)` returns a `Disposable` handle for callers whose critical section is not
a single function. Acquisition blocks with jittered backoff and **throws** `TimeoutInterruption`
when it cannot be taken within `timeout` (default 10s) — it never falls through and runs the
section unlocked. `timeout: 0` is a deterministic try-lock: one attempt, no waiting, no backoff, no
queueing behind a same-process caller — live contention throws `TimeoutInterruption`
synchronously. Acquiring a lock creates `lockPath`'s parent directory tree if it does not already
exist.

The lock is claimed by `link()`-ing a fully-written temp file into place, so no racer can ever read
a half-written lockfile and conclude nobody holds it. Reap and release are inode-guarded, though the
guard narrows the reap's race window rather than closing it: `statSync` then `rmSync` is two
syscalls, and in a rare crash-only interleaving two waiters reaping the same stale lock in lockstep
can have one unlink the other's freshly-claimed live lock. A jitter before reaping desynchronizes
waiters released together and makes this vanishingly unlikely, but it is a mitigation, not a proof —
the one place this package's exclusion is probabilistic rather than absolute.

Stale-lock recovery proves liveness rather than assuming it. A holder on this host, from this boot,
whose pid still answers `kill(pid, 0)` is never reaped — no matter how long it holds the lock,
because a critical section can legitimately block the event loop for minutes (a synchronous keyring
call, an OS keychain prompt). Where liveness can't be proven, the `staleTimeout` TTL (default 60s)
applies, and how the holder is aged depends on its host: same-host holders are aged monotonically
from `os.uptime()`, so a forward wall-clock step cannot reap a live one, and a negative age (uptime
below the recorded value) means the host rebooted, so the record is stale at once. A foreign-host
holder is still aged by wall clock — another host's uptime can't be read — so a clock step can still
expire its record early; this is one reason cross-host locking is unsupported.

The process-exit cleanup hook releases held locks on `process.exit()` and a natural event-loop
drain only. A default-handled `SIGINT`/`SIGTERM` terminates Node without emitting `'exit'`, so a
lock held across one is not released by the hook; this is benign, since the next waiter's liveness
probe finds the pid dead and reaps immediately.

Acquisition surfaces real filesystem errors (e.g. `EACCES`, `EISDIR`) instead of misreporting a
misconfigured `lockPath` as a held lock, so a caller's error handling should not assume every
rejection is a `TimeoutInterruption`.

Node-only, and `lockPath` must be on a local filesystem — `link()` atomicity is not guaranteed on
NFS.
