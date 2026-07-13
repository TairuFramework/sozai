---
"@sozai/lock": minor
---

First release of `@sozai/lock`: a blocking cross-process file mutex for Node.js.

`withFileLock(lockPath, fn)` runs a critical section under an exclusive lock, and
`acquireFileLock(lockPath)` returns a `Disposable` handle for callers whose critical section is not
a single function. Acquisition blocks with jittered backoff and **throws** `TimeoutInterruption`
when it cannot be taken within `timeout` (default 10s) — it never falls through and runs the
section unlocked. `timeout: 0` is a deterministic try-lock: one attempt, no waiting, no backoff, no
queueing behind a same-process caller — live contention rejects with `TimeoutInterruption` in the
same tick, before any timer can fire. (`acquireFileLock` is `async`, so it rejects rather than
throwing synchronously; what it guarantees is that it never sleeps and never waits on a timer.)
Acquiring a lock creates `lockPath`'s parent directory tree if it does not already exist.

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
applies.

"From this boot" is decided by an **OS boot ID**, never by the clock, and that is the load-bearing
safety property: `LockRecord.bootID` is `/proc/sys/kernel/random/boot_id` on linux and `sysctl -n
kern.bootsessionuuid` on darwin — read once per process, cached, and never able to throw (it is
`null` on any other platform or on any read failure). When this process and the record both have
one, they are compared exactly. So **on linux and darwin a forward wall-clock step cannot reap a
live holder**: the step cannot suppress the liveness proof, because a boot ID does not move when the
clock does, so the pid is still probed and still answers; and it cannot inflate the holder's age
either, because a same-host holder is aged monotonically from `os.uptime()` (`uptimeAt`). Where no
boot ID is readable — any other platform, or a record written by a process that could not read one —
the check falls back to comparing wall-clock-derived boot *times* (`bootAt`) within a 30s tolerance,
and a larger step there does still cost a live holder its liveness proof. It no longer costs it the
lock (the monotonic age still holds the TTL back), but the guarantee is a linux/darwin guarantee,
not a universal one.

A negative monotonic age (uptime below the recorded value) signals a reboot, and is reaped once the
wall clock corroborates it — either with a claim older than the TTL, or with a claim dated in the
*future*, which is what a host whose clock has run *backwards* past the record leaves behind (a bad
RTC, a container booted to 1970 before NTP lands; without this second corroboration such a host
never reaps the record at all and the lock wedges forever). Reboot recovery is **TTL-bounded in
every case, never instant**: a holder that claimed the lock seconds into a boot leaves a record
whose uptime sits below the new boot's — a small positive age, no reboot signal — and a *fast*
reboot (a container restart, a kexec — seconds of downtime, where hold + downtime + the new uptime
is still under the TTL) cannot corroborate its negative age yet. Both wait the TTL out: reap
latency, never an exclusion hole and never a wedge.

A foreign-host holder is still aged by wall clock — another host's uptime can't be read — so a clock
step can still expire its record early; this is one reason cross-host locking is unsupported.

The process-exit cleanup hook releases held locks on `process.exit()` and a natural event-loop
drain only. A default-handled `SIGINT`/`SIGTERM` terminates Node without emitting `'exit'`, so a
lock held across one is not released by the hook; this is benign, since the next waiter's liveness
probe finds the pid dead and reaps immediately.

Acquisition surfaces real filesystem errors (e.g. `EACCES`, `EISDIR`) instead of misreporting an
unusable `lockPath` as a held lock, so a caller's error handling should not assume every rejection
is a `TimeoutInterruption`. That covers a directory sitting at the path, and equally a lockfile that
is simply unreadable to us: a `0600` lockfile owned by ANOTHER user, on a path two users share, now
throws `EACCES` on the first read rather than being waited out. Correct for the per-user keystore
this guards, but a shared-path caller must expect it.

Node-only, and `lockPath` must be on a local filesystem — `link()` atomicity is not guaranteed on
NFS.
