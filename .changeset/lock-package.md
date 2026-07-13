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
kern.bootsessionuuid` on darwin — read and cached per process, and never able to throw. A *failed*
read is retried before any caller is answered (a `null` handed out here is written into a lock record,
where it is frozen for the life of the hold), and a source that fails an entire acquisition's budget
is read again on the next acquisition, so one unlucky claim cannot downgrade the process to the
fallback for its whole life; an unsupported platform settles on `null` at once, since no retry can
change what the platform does not publish. When this process and the record both have one, they are
compared exactly. So **on linux and darwin, where the boot ID is readable, a forward wall-clock step
cannot reap a live holder**: the step cannot suppress the liveness proof, because a boot ID does not
move when the clock does, so the pid is still probed and still answers; and it cannot inflate the
holder's age either, because a same-host holder is aged monotonically from `os.uptime()` (`uptimeAt`).
The qualifier is load-bearing: the read can fail on both platforms, and a process it failed for is on
the fallback below.

The **hostname** is consulted only where it is load-bearing, and after the boot ID: it is a mutable
machine identity (macOS renames the host from DHCP when a laptop joins a network — the very
sleep/wake event this package is written for), so gating the pid probe on it reaped live, same-boot
holders. On **darwin** a matching boot ID proves the same machine *and* the same pid namespace, so it
authorizes the probe whatever the host is called now. On **linux** it does not — containers on one
host share `/proc/sys/kernel/random/boot_id` but have separate pid namespaces, so a boot-ID match can
be two different containers and the recorded pid would probe a stranger — and the hostname check
stays there. It discriminates because containers get distinct hostnames *by default*, not by
guarantee (`--hostname`, `--uts=host`, `--net=host` defeat it), so a `lockPath` **must not be shared
between containers**, exactly as it must not be shared between hosts.

**Where no boot ID is readable, the fallback is not safe, and the TTL does not protect a long-held
lock.** That covers any other platform, and equally a record written by a process whose read *failed*
— possible on linux (`EMFILE`) and on darwin, where the boot ID comes from an **exec**, so a macOS App
Sandbox or hardened runtime that denies the `sysctl` spawn leaves that process here permanently. The
check then falls back to comparing wall-clock-derived boot *times* (`bootAt`) within a 30s tolerance,
and the hostname becomes the only machine identity there is — so **two** events reap a live holder
there, as soon as its true monotonic age passes `staleTimeout`: a **forward clock step** larger than
the tolerance (the minutes-long keychain-prompt hold this package exists for is exactly such a holder,
and sleep/wake supplies the step), *and* a **hostname change with no clock event at all** — a DHCP
rename alone, on a perfectly steady clock, costs a live darwin holder its lock at the TTL, and the
macOS/laptop/DHCP population is precisely the one a denied `sysctl` spawn strands here. What the
monotonic `uptimeAt` age buys is narrower: it removes the *inflated* age, so a holder *younger* than
the TTL is no longer reaped by the clock step alone. The guarantee above is a linux/darwin
readable-boot-ID guarantee, not a universal one, and a consumer that may not have one must know it.

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
step can still expire its record early, and a *future-dated* foreign record is respected until our
own clock catches up to its `startedAt` (a wait bounded by the peer's skew, not by the TTL). Both are
reasons cross-host locking is unsupported.

A pid **recycled within the same boot** still wedges the lock: a `SIGKILL`ed holder whose lockfile
outlives the pid space wrapping around to that number probes as alive, is never stale, and needs a
reboot or a manual `rm`. The boot ID removes the *cross-reboot* recycle, not this one. It is an
availability failure rather than an exclusion failure — it fails in the safe direction — and it is
the deliberate price of rejecting a `maxHoldTime` outer bound, which would re-open the
reap-a-live-holder hole the rest of the design closes.

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
