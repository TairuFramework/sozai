import { hostname } from 'node:os'

import type { LockEntry } from './file.js'
import { getBootAt, getUptimeAt, type LockRecord } from './record.js'

/**
 * How far the recorded boot time may drift from ours and still describe the same boot.
 * `os.uptime()` and `Date.now()` diverge under NTP correction, so the comparison needs slack —
 * and a mismatch only downgrades a holder to `unknown`, never reaps it: the age rules below
 * decide.
 *
 * On the wall clock, that downgrade would not be enough. A forward step larger than the TTL
 * (NTP correction, VM resume, laptop wake, a container with a bad RTC) pushes a LIVE holder's
 * record out of this tolerance AND inflates `now - startedAt` past the TTL — one step, both
 * halves of the reap condition, two processes in the critical section. Which is why a same-host
 * holder is aged by `uptimeAt` instead: see `isStale`.
 */
export const BOOT_TOLERANCE_MS = 30_000

export type Liveness = 'alive' | 'dead' | 'unknown'

/**
 * Liveness is proven, never assumed. A pid is only meaningful on the host that recorded it and
 * within the boot that recorded it: across hosts, and across a reboot, the same number belongs
 * to somebody else.
 */
export function checkLiveness(record: LockRecord): Liveness {
  if (record.hostname !== hostname()) {
    return 'unknown'
  }
  if (Math.abs(record.bootAt - getBootAt()) > BOOT_TOLERANCE_MS) {
    return 'unknown'
  }
  try {
    // Signal 0 performs the permission and existence check without delivering a signal. The
    // record was validated with `pid > 0`, so this can never signal a process group.
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
 * A provably-live holder is NEVER stale, no matter how long it has held the lock. This is the
 * requirement that rules out a heartbeat design: a critical section can block the event loop for
 * minutes (a synchronous keyring call, an OS keychain prompt), so any liveness signal the holder
 * has to emit on a timer would starve — and a TTL-based reaper would then hand a second process
 * the same critical section. Exactly the bug this package exists to prevent.
 *
 * The TTL applies only where the pid means nothing: a foreign host, a different boot, or a record
 * too corrupt to identify a holder at all. How the holder's age is measured then depends on
 * whether we can measure it at all:
 *
 * - SAME HOST: monotonically, from `uptimeAt`. No wall-clock step can INFLATE that age, so a clock
 *   step can never reap a live holder. A NEGATIVE age — this host has been up for less time than
 *   the record claims to have been held — is the reboot signal, but it is not a reboot PROOF:
 *   `os.uptime()` is not portably monotonic (on darwin it is `time(NULL) - kern.boottime`, and the
 *   kernel adjusts `kern.boottime` on clock and sleep events), so a forward `boottime` bump can
 *   hand a LIVE holder a boot mismatch and a negative age together. So the reboot verdict is
 *   corroborated by the wall clock: stale at once only if the record was ALSO claimed longer than
 *   the TTL ago. A reboot always has real downtime, so it still fires; a forward clock step alone
 *   cannot produce a negative age, so nothing here reintroduces the wall clock's reap-a-live-holder
 *   hole.
 * - FOREIGN HOST, or a record too corrupt to carry an uptime (dated, then, by the file's own
 *   mtime): the wall clock is all there is, because another host's uptime is unreadable to us.
 *   A clock step on EITHER machine can therefore still expire such a record early. Unavoidable,
 *   and the reason cross-host locking is not supported.
 *
 * What this trades away, and it is a real trade rather than a strictly better signal: a holder that
 * claimed the lock a few seconds into a boot, followed by a REBOOT, leaves a record whose `uptimeAt`
 * sits BELOW the new boot's current uptime — a small POSITIVE age, so it is respected for the full
 * TTL. The wall-clock rule this replaced reaped it at once. That is reap LATENCY bounded by the
 * TTL, never an exclusion hole, and it is inherent: from the wall clock alone a reboot and a
 * forward clock step are indistinguishable, which is exactly why the wall clock had to go.
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
        // Uptime ran backwards: a reboot, or a darwin `kern.boottime` adjustment under a live
        // holder. Only the first leaves a claim older than the TTL behind it.
        return now - record.startedAt > staleTimeout
      }
      return age > staleTimeout
    }
  }
}
