import { hostname, platform } from 'node:os'

import type { LockEntry } from './file.js'
import { getBootAt, getBootID, getUptimeAt, type LockRecord } from './record.js'

/**
 * Tolerance for the wall-clock FALLBACK boot comparison only (see `isSameBoot`) — `os.uptime()`
 * and `Date.now()` diverge under NTP correction, so the comparison needs slack.
 */
export const BOOT_TOLERANCE_MS = 30_000

export type Liveness = 'alive' | 'dead' | 'unknown'

/**
 * Is `record` from the boot we are running in? This gates the pid probe in `checkLiveness`, so
 * getting it wrong is the whole safety property, not a nuance: call a live holder's boot
 * "different" and the TTL reaps it while it still holds the lock; call a previous boot's holder
 * "same" and its recycled pid answers `kill(pid, 0)` as somebody else, wedging a persistent
 * `lockPath` forever.
 *
 * An OS boot ID is compared for exact equality whenever both sides have one — it does not move
 * with the clock and always changes across a reboot. The `bootAt` (wall-clock) comparison is a
 * FALLBACK for a platform or a read with no boot ID, and it is NOT safe: a tight tolerance reaps a
 * live holder across an NTP step or laptop wake (which can hold the critical section for minutes —
 * a macOS keychain prompt), and a wide one lets a reboot inside the window wedge on a recycled pid.
 * Do not "fix" this by retuning `BOOT_TOLERANCE_MS`; the trade has no safe side. The monotonic
 * `uptimeAt` age in `isStale` narrows the exposure on this path (a holder younger than the TTL
 * still survives) but does not close it.
 */
function isSameBoot(record: LockRecord, bootID: string | null): boolean {
  if (bootID !== null && record.bootID !== null) {
    return record.bootID === bootID
  }
  return Math.abs(record.bootAt - getBootAt()) <= BOOT_TOLERANCE_MS
}

/**
 * Does a boot-ID match, on this platform, also prove the recorded pid lives in OUR pid namespace —
 * i.e. that probing it probes the process that wrote the record, not a stranger holding that
 * number?
 *
 * Do not collapse the two branches — the asymmetry is load-bearing:
 *
 * - DARWIN: yes. `kern.bootsessionuuid` is per machine, per boot; macOS has no pid namespaces, and
 *   a container "on a Mac" is really a linux VM reporting platform `linux` with its own `boot_id`.
 *   The hostname need not be consulted at all — which matters, because macOS renames the host from
 *   DHCP when a laptop joins a network, and gating on the hostname would reap a live, same-boot
 *   holder on every rename.
 * - LINUX: no. Containers on one host SHARE `boot_id` but have SEPARATE pid namespaces, so a
 *   boot-ID match can be two different containers with an unrelated process at the same pid. The
 *   hostname is the only discriminator, and containers get distinct hostnames BY DEFAULT — not a
 *   guarantee: `--hostname`, `--uts=host` or `--net=host` gives two containers the same hostname
 *   and `boot_id` with separate pid namespaces, and this does not detect that. Sharing a `lockPath`
 *   between containers is unsupported, exactly as sharing one between hosts is.
 * - ANYWHERE ELSE: no boot ID is published, so this is unreachable — answer no, since the hostname
 *   is then the only machine identity there is.
 */
function bootIDProvesSamePIDNamespace(): boolean {
  return platform() === 'darwin'
}

/**
 * Is this record from the same boot AND the same pid namespace as us — the two things that have to
 * hold before `record.pid` means anything here?
 *
 * Hostname is a WEAK, mutable machine identity (DHCP renames a macOS laptop on joining a network),
 * so it is consulted only where load-bearing — as the linux pid-namespace discriminator, and as
 * the sole machine identity on the fallback path — never as a gate in front of a darwin boot-ID
 * match, which already proves more.
 *
 * OUR boot ID is passed in, never re-read here: see `checkLiveness`.
 */
function isSameBootAndPIDNamespace(record: LockRecord, bootID: string | null): boolean {
  if (bootID !== null && record.bootID !== null) {
    return (
      record.bootID === bootID && (bootIDProvesSamePIDNamespace() || record.hostname === hostname())
    )
  }
  // No boot ID on one side or the other: hostname is the only machine identity left, so it gates
  // the fallback comparison rather than being skipped by it.
  return record.hostname === hostname() && isSameBoot(record, bootID)
}

/**
 * Liveness is proven, never assumed: a pid means something only within the boot and pid namespace
 * that recorded it.
 *
 * `getBootID()` is read ONCE and threaded through, rather than re-read inside `isSameBoot`: it is
 * not a constant, and a caller reading it twice could be answered `null` once and a real boot ID
 * once across a retry reset (`retryBootIDRead`), deciding a live holder's fate from two different
 * boots.
 */
export function checkLiveness(record: LockRecord): Liveness {
  if (!isSameBootAndPIDNamespace(record, getBootID())) {
    return 'unknown'
  }
  try {
    // Signal 0 checks permission/existence without delivering a signal. The record was validated
    // with `pid > 0`, so this can never signal a process group.
    process.kill(record.pid, 0)
    return 'alive'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') {
      return 'dead'
    }
    // EPERM: the process exists, it just belongs to another user. That is a live holder.
    return code === 'EPERM' ? 'alive' : 'unknown'
  }
}

/**
 * May a waiter take this lock away from its holder?
 *
 * A provably-live holder is NEVER stale, no matter how long it has held the lock. This rules out a
 * heartbeat design: a critical section can block the event loop for minutes (an OS keychain
 * prompt), so any liveness signal emitted on a timer would starve, and a TTL-based reaper would
 * then hand a second process the same critical section — exactly the bug this package exists to
 * prevent.
 *
 * The price: a pid recycled WITHIN THE SAME BOOT wedges the lock forever (a SIGKILLed holder's
 * lockfile outlives the pid space wrapping around to its number, probes 'alive', and needs a
 * reboot or a manual unlink). This is an AVAILABILITY failure, not an exclusion failure — it fails
 * safe. A `maxHoldTime` bound was rejected because it fails UNSAFE: it would reap a still-live
 * holder for holding the lock too long.
 *
 * The TTL applies only where the pid means nothing: a foreign host, a different boot, or a record
 * too corrupt to identify a holder.
 *
 * - SAME HOST: age is measured monotonically from `uptimeAt`, so no wall-clock step can inflate
 *   it. A NEGATIVE age (this host has been up for less time than the record claims to have been
 *   held) signals a reboot but is not proof — `os.uptime()` is not portably monotonic (on darwin
 *   it is `time(NULL) - kern.boottime`, adjusted by the kernel on clock and sleep events even
 *   without a reboot). So the reboot verdict is corroborated, by either of the two things a live
 *   holder cannot produce: a claim older than the TTL, or a claim from the FUTURE (`now <
 *   startedAt`) — needed because a clock running BACKWARDS past the record (a bad RTC, a container
 *   booted before NTP lands) makes `now - startedAt` permanently negative, so the TTL check alone
 *   would never fire and a dead post-reboot holder would wedge the lock forever.
 * - FOREIGN HOST, or a record too corrupt to carry an uptime: only the wall clock is available, so
 *   a clock step on EITHER machine can expire such a record early. Unavoidable, and why cross-host
 *   locking is unsupported. A future-dated FOREIGN record is left alone: there is no reboot signal
 *   to corroborate, and that is exactly what a live remote holder writes.
 */
export function isStale(entry: LockEntry, staleTimeout: number, now: number = Date.now()): boolean {
  const { record, mtimeMs } = entry
  if (record == null) {
    // No holder can be identified. Only the filesystem can date the file, and a file that has
    // vanished under us is not a lock anyone still holds.
    return mtimeMs == null || now - mtimeMs > staleTimeout
  }
  switch (checkLiveness(record)) {
    case 'alive':
      return false
    case 'dead':
      return true
    case 'unknown': {
      if (record.hostname !== hostname()) {
        return now - record.startedAt > staleTimeout
      }
      const age = getUptimeAt() - record.uptimeAt
      if (age < 0) {
        // Negative age: reboot signal, not proof (see doc above). Corroborate before reaping.
        return now < record.startedAt || now - record.startedAt > staleTimeout
      }
      return age > staleTimeout
    }
  }
}
