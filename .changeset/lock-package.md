---
"@sozai/lock": minor
---

First release of `@sozai/lock`: a blocking, filesystem-based cross-process mutex.

`withFileLock(lockPath, fn)` runs a critical section under an exclusive lock; `acquireFileLock`
returns a `Disposable` handle. Acquisition blocks with jittered backoff and **throws**
`TimeoutInterruption` when it cannot be taken within `timeout` (default 10s) — it never falls
through and runs the section unlocked. `timeout: 0` is a deterministic try-lock. The lock is claimed
by `link()`-ing a fully-written temp file into place, so no racer can read a half-written lockfile
and conclude nobody holds it. Reap and release are guarded on the record's per-claim nonce, not on
the lockfile's inode: an inode number is recycled the moment the file is unlinked, so it names a
slot rather than a file and cannot tell a fresh lock from the reaped one it replaced.

Stale-lock recovery proves liveness rather than assuming it: a holder on this host, from this boot,
whose pid answers `kill(pid, 0)` is never reaped, however long it holds — a critical section can
legitimately block the event loop for minutes (an OS keychain prompt), so a TTL alone would hand a
second process the same section. "From this boot" comes from an OS boot ID
(`/proc/sys/kernel/random/boot_id` on linux, `sysctl -n kern.bootsessionuuid` on darwin), never from
the clock, and a same-host holder's age is measured monotonically from `os.uptime()`. Where liveness
cannot be proven, the `staleTimeout` TTL (default 60s) applies.

Known limits, all documented in the README:

- Where no boot ID is readable (Windows; a failed read on linux/darwin, including a sandboxed macOS
  process that cannot spawn `sysctl`), the fallback compares wall-clock boot times and the hostname
  — so a live holder held past `staleTimeout` can be reaped by a >30s clock step or a hostname
  change.
- A pid recycled within one boot wedges the lock (availability, not exclusion).
- Reaping is guarded but not atomic (the read and the unlink are separate syscalls); POSIX has no
  unlink-if-identity.
- `lockPath` must be on a local filesystem and must not be shared across hosts or containers.
- Not reentrant. Acquisition can reject with `EACCES`/`EISDIR`, not only `TimeoutInterruption`.
