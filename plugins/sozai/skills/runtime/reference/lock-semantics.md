# @sozai/lock — semantics and failure modes

Sibling reference: `reference/lock.md` — exports and everyday usage.

**"Same boot" is decided by an OS boot ID, not by the clock**, and that is the load-bearing safety
property: `bootID` is `/proc/sys/kernel/random/boot_id` on linux and `sysctl -n
kern.bootsessionuuid` on darwin (read and cached per process — never throws; a *failed* read is
retried before anybody is answered, and a source that fails an acquisition's whole budget is read
again on the next acquisition, so one unlucky claim cannot downgrade the process for life; an
unsupported platform settles on `null` at once). When both this process and the record have one, they
are compared exactly. So on linux and darwin, **where the boot ID is readable**, **a forward
wall-clock step cannot reap a live holder**: the step cannot suppress the liveness proof (the boot ID
does not move with the clock, so the pid is still probed and still answers), and it cannot inflate the
age either (a same-host holder is aged monotonically from `uptimeAt`). The qualifier is load-bearing —
the read *can* fail on both platforms, and a process it failed for gets none of this.

The **hostname** is checked *after* the boot ID, and only where it is load-bearing — it is a machine
identity, not a boot identity, and a mutable one (macOS renames the host from DHCP when a laptop
joins a network, which is the very sleep/wake event this package is written for). On **darwin** a
matching boot ID proves the same machine *and* the same pid namespace, so it authorizes the pid probe
whatever the host is called now. On **linux** it does not: containers on one host *share*
`/proc/sys/kernel/random/boot_id` but have *separate* pid namespaces, so a boot-ID match can be two
different containers and the recorded pid would probe a stranger — the hostname check stays on that
path, and must not be "simplified" into the darwin one. It discriminates because containers get
distinct hostnames *by default*, which is a default and not a guarantee (`--hostname`, `--uts=host`,
`--net=host`), so sharing a `lockPath` **between containers is unsupported**, exactly as sharing one
between hosts is.

**The fallback path is not safe, and the TTL does not protect a long-held lock there.** Where no boot
ID is readable — any other platform, or a record written by a process whose read *failed*, which is
possible on linux (`EMFILE`) and on darwin (the boot ID comes from an **exec**: a macOS App Sandbox or
hardened runtime that denies the `sysctl` spawn puts that process here permanently) — the check falls
back to comparing wall-clock-derived boot *times* (`bootAt`) within a 30s tolerance, and the hostname
becomes the only machine identity there is. **Two** events then reap a live holder on this path, as
soon as its true monotonic age passes `staleTimeout`:

- a **forward clock step** larger than the tolerance — the minutes-long macOS-keychain-prompt hold
  this package exists for is exactly such a holder, and sleep/wake supplies the step;
- a **hostname change, with no clock event at all**. A DHCP rename alone, on a perfectly steady
  clock, costs a live darwin holder its lock at the TTL — and a laptop on DHCP, whose `sysctl` spawn
  a sandbox denied, is precisely the process that ends up here. **This one is not confined to the
  fallback**: `bootIDProvesSamePIDNamespace()` is darwin-only, so on **linux** the same reap happens
  to a live holder even with a matching, readable boot ID, purely from the hostname changing (two
  containers sharing a host's boot ID land here).

What `uptimeAt` buys on that path is narrower: it removes the *inflated* age, so a holder *younger*
than the TTL is no longer reaped by the clock step alone. A consumer that may not have a readable boot
ID must know that its long-held lock is not TTL-protected. `bootAt` remains on the record for exactly
this fallback, and the guarantee above is a linux/darwin *readable-boot-ID* one, not a universal one.

A *negative* monotonic age (this host has been up for less time than the record claims to have been
held) signals a reboot, and is corroborated by the wall clock before anything is reaped — either a
claim older than the TTL (`now - startedAt > staleTimeout`) or a claim dated in the *future*
(`now < startedAt`). Corroboration is required because `os.uptime()` is not portably monotonic
(darwin adjusts `kern.boottime` on clock and sleep events, so it can run backwards under a live
holder); the future-dated case is required because a host whose clock runs *backwards* past the
record — a bad RTC, a container booted to 1970 before NTP lands — makes `now - startedAt`
permanently negative, so without it a dead post-reboot holder would never be reaped and the lock
would wedge forever.

**Reboot recovery is TTL-bounded in every case, never instant.** A reboot always changes the boot
ID, so a recycled pid is never mistaken for a live holder — but two cases wait the TTL out in full:
a holder that claimed the lock seconds into a boot (its `uptimeAt` sits *below* the new boot's
uptime, so its age is small and positive, with no reboot signal at all), and a *fast* reboot — a
container restart, a kexec, seconds of downtime — where hold + downtime + the new uptime is still
under the TTL, so the negative age cannot be corroborated yet. Reap latency, bounded by the TTL,
never an exclusion hole — with one exception, confined to the fallback itself: a reboot faster than
the 30s `bootAt` tolerance is indistinguishable there from clock drift and is read as the same boot,
so a pid recycled across it wedges the lock exactly as a same-boot recycle does.

A foreign-host holder (or a record too corrupt to identify one) is still aged by wall clock against
`startedAt`, or the file's mtime — unavoidable, since another host's uptime can't be read, and the
reason cross-host locking is unsupported. A clock step can still expire a foreign-host record early;
and in the other direction, a *future-dated* foreign record is respected until our own clock passes
its `startedAt` plus the TTL, so the wait is the peer's skew on top of the full TTL. (Deliberate: two
hosts' clocks legitimately disagree, and a foreign record carries no reboot signal to corroborate
reaping it early — only the claim itself, which is what a live remote holder writes.)

**A pid recycled within the same boot still wedges the lock.** A `SIGKILL`ed holder whose lockfile
outlives the pid space wrapping around to that number probes as `'alive'`, is therefore never stale,
and is unrecoverable without a reboot or a manual `rm`. The boot ID removes the *cross-reboot*
recycle — the common case, where a persistent `lockPath` survives a reboot — and not this one. This
is an availability failure, not an exclusion failure: it fails in the safe direction and never lets
two processes into the critical section. It is the deliberate price of rejecting a `maxHoldTime`
outer bound, which would re-open the reap-a-live-holder hole the rest of the design exists to close.

Reaping a stale lock is guarded, not provably atomic: the reaper unlinks the lockfile only while it
still carries the record it classified stale — identified by matching the inode it was linked at,
corroborated by a per-claim **nonce**. The inode is checked first but is not sufficient alone,
because an inode number is recycled the moment the file is unlinked (routinely on linux) and so
names a slot, not a file; the nonce is what tells a freshly-claimed lock in that slot from the stale
one just reaped out of it. Reading and unlinking are still two syscalls, so a residual window
remains where two waiters classifying the same stale lock in lockstep can have one unlink the
other's freshly-claimed live lock. POSIX has no unlink-if-identity, so this can't be closed with name
operations; a jitter before reaping (uniform in `[0, retryDelay)`, skipped by a try-lock)
desynchronizes waiters released together so this doesn't happen in practice — a mitigation, not a
proof, and the one place this package's exclusion is probabilistic.

The exit-cleanup hook releases held locks on `process.exit()` and a natural event-loop drain only —
a default-handled `SIGINT`/`SIGTERM` terminates Node without emitting `'exit'`, so it does not run
there. Benign: the process is gone, so the next waiter's liveness probe reports it dead and reaps
immediately, no TTL wait.

Acquisition can reject with a real filesystem error (`EACCES`, `EISDIR`, ...) instead of timing out,
when `lockPath` is unusable: a directory sitting at the path, or a lockfile unreadable to us — a
`0600` lockfile owned by another user, on a shared path, throws `EACCES` on the first read rather
than being waited out. A caller should not assume every rejection is `TimeoutInterruption`.

`retryDelay` is a backoff ceiling, not the realized first delay: the first wait is uniform in
`[retryDelay / 2, retryDelay)` (`[5, 10)` at the default).
