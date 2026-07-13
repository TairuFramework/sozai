import { hostname } from 'node:os'

import type { LockEntry } from './file.js'
import { getBootAt, type LockRecord } from './record.js'

/**
 * How far the recorded boot time may drift from ours and still describe the same boot.
 * `os.uptime()` and `Date.now()` diverge under NTP correction, so the comparison needs slack —
 * and a mismatch only downgrades a holder to `unknown` (TTL decides), never reaps it. Clock skew
 * therefore costs latency, never mutual exclusion.
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
 * too corrupt to identify a holder at all (dated, then, by the file's own mtime).
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
    case 'unknown':
      return now - record.startedAt > staleTimeout
  }
}
