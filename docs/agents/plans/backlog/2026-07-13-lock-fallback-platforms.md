# lock — close the no-boot-ID fallback hole

**Status:** open · low priority (no consumer on an affected platform yet)
**Package:** `@sozai/lock`
**Context:** [completed/2026-07-13-lock-package](../completed/2026-07-13-lock-package.complete.md)

## The gap

`@sozai/lock` proves a holder is alive before refusing to reap it: same machine, same boot, and
`process.kill(pid, 0)` answers. "Same boot" comes from an OS boot ID — `/proc/sys/kernel/random/boot_id`
on linux, `sysctl -n kern.bootsessionuuid` on darwin — precisely because a wall-clock-derived boot
time is corrupted by an NTP correction or a laptop wake, and a corrupted one costs the holder its
liveness proof and therefore its lock.

Where no boot ID can be read, the package falls back to comparing a wall-clock-derived `bootAt`
within a 30s tolerance, plus the hostname. On that path **a live holder that has held longer than
`staleTimeout` is reaped** by either:

- a forward wall-clock step larger than 30s, or
- a hostname change (macOS renames the host from DHCP on network join).

This is documented in the README, the reference docs, and `liveness.ts` — it is a known, stated
limit, not a surprise. It bites two populations:

1. **Windows.** No boot-ID source is implemented at all, so every Windows process is on the fallback.
2. **Sandboxed macOS.** The darwin boot ID comes from spawning `/usr/sbin/sysctl`. An App Sandbox or
   hardened runtime that blocks `posix_spawn` puts that process permanently on the fallback — and it
   is exactly the macOS/laptop/DHCP-rename population the boot ID was added to protect.

## What would close it

- **A Windows boot-ID source.** It must be clock-independent: `LastBootUpTime` from WMI is wall-clock
  derived and would inherit the very bug being fixed. Something rooted in `GetTickCount64` or a
  per-boot kernel identifier is what is wanted; establish first whether one is reachable from Node
  without a native addon.
- **A non-exec darwin source**, so a sandboxed process is not silently downgraded. If none exists,
  surface the downgrade instead of hiding it — a consumer that cannot get a boot ID is running with a
  weaker guarantee than the docs' headline, and today only the fallback's own paragraph says so.

## Also accepted, and deliberately not fixed

Recorded here so they are not rediscovered as bugs:

- **`reapLockFile` has a residual TOCTOU window.** The inode guard is `statSync` then `rmSync` — two
  syscalls — so two waiters that both classify the same stale inode can interleave such that the
  second unlinks the first's *fresh* lock. POSIX has no unlink-if-inode, so it cannot be closed with
  name operations; it is narrowed by jittering before a reap so waiters released by one stale lock do
  not reap in lockstep.
- **A pid recycled within a single boot wedges the lock.** A SIGKILLed holder whose lockfile outlives
  the pid space wrapping probes as alive and is never reaped. Availability-only — it fails loud
  (acquire throws) rather than silently, and a `maxHoldTime` outer bound was rejected because it
  would re-open the reap-a-live-holder hole the whole design exists to close.
- **Sharing a `lockPath` across containers is unsupported.** Containers on one host share
  `/proc/sys/kernel/random/boot_id` but have separate pid namespaces, so a pid probe there reads a
  stranger's process. The hostname check is what separates them on linux, which is why the linux
  branch may not be "simplified" into the darwin one.
