import { hostname, platform } from 'node:os'

import type { LockEntry } from './file.js'
import { getBootAt, getBootID, getUptimeAt, type LockRecord } from './record.js'

/** Slack for the wall-clock fallback only: `os.uptime()` and `Date.now()` drift under NTP. */
export const BOOT_TOLERANCE_MS = 30_000

export type Liveness = 'alive' | 'dead' | 'unknown'

/**
 * Gates the pid probe: a pid from another boot belongs to someone else.
 *
 * The `bootAt` branch is a fallback for platforms with no boot ID, and it is NOT safe — a clock
 * step can reap a live holder. Retuning `BOOT_TOLERANCE_MS` does not fix it; the trade has no safe
 * side. Prefer adding a boot-ID source for the platform.
 */
function isSameBoot(record: LockRecord, bootID: string | null): boolean {
  if (bootID !== null && record.bootID !== null) {
    return record.bootID === bootID
  }
  return Math.abs(record.bootAt - getBootAt()) <= BOOT_TOLERANCE_MS
}

/**
 * Does a boot-ID match also prove the pid is in our namespace?
 *
 * Do NOT collapse these branches. darwin: yes — no pid namespaces, so the hostname need not be
 * consulted (and must not be: DHCP renames a Mac laptop mid-hold). linux: no — containers share the
 * host's `boot_id` but not its pid namespace, so the hostname is the only discriminator. Sharing a
 * `lockPath` between containers is unsupported.
 */
function bootIDProvesSamePIDNamespace(): boolean {
  return platform() === 'darwin'
}

/** Hostname is a weak identity (DHCP renames), so it gates only where nothing stronger exists. */
function isSameBootAndPIDNamespace(record: LockRecord, bootID: string | null): boolean {
  if (bootID !== null && record.bootID !== null) {
    return (
      record.bootID === bootID && (bootIDProvesSamePIDNamespace() || record.hostname === hostname())
    )
  }
  return record.hostname === hostname() && isSameBoot(record, bootID)
}

/**
 * Liveness is proven, never assumed.
 *
 * Our boot ID is read once and threaded through: it is not a constant (a failed read is retried),
 * and two reads could answer `null` then a real ID, judging one holder against two boots.
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
 * A provably-live holder is NEVER stale, however long it holds — a critical section can block the
 * event loop for minutes (an OS keychain prompt), so a heartbeat would starve and a TTL would then
 * hand a second process the same section. The price is that a pid recycled within one boot wedges
 * the lock: an availability failure, where reaping a live holder is an exclusion failure. Do not
 * add a `maxHoldTime` to "fix" the wedge — it trades the safe failure for the unsafe one.
 *
 * The TTL applies only where the pid means nothing: a foreign host, another boot, a corrupt record.
 */
export function isStale(entry: LockEntry, staleTimeout: number, now: number = Date.now()): boolean {
  const { record, mtimeMs } = entry
  if (record == null) {
    // Unidentifiable holder: only the filesystem can date it, and a vanished file holds nothing.
    return mtimeMs == null || now - mtimeMs > staleTimeout
  }
  switch (checkLiveness(record)) {
    case 'alive':
      return false
    case 'dead':
      return true
    case 'unknown': {
      // Foreign host: no uptime we can read, so the wall clock is all there is — a clock step on
      // either machine can expire it early. Cross-host locking is unsupported for this reason.
      if (record.hostname !== hostname()) {
        return now - record.startedAt > staleTimeout
      }
      // Same host: monotonic age, so no clock step can inflate it.
      const age = getUptimeAt() - record.uptimeAt
      if (age < 0) {
        // Uptime ran backwards. Suggests a reboot, but darwin also does this on clock/sleep events,
        // so corroborate with something a live holder cannot produce: a claim past the TTL, or one
        // from the future (a backwards clock, which would otherwise wedge the lock forever).
        return now < record.startedAt || now - record.startedAt > staleTimeout
      }
      return age > staleTimeout
    }
  }
}
