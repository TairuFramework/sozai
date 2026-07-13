import { hostname, uptime } from 'node:os'

/**
 * The on-disk lock. It carries what a waiter needs to *prove* the holder is alive, and
 * nothing else — never key material, never caller payload. Whatever the lock guards stays
 * in the store the lock guards.
 */
export type LockRecord = {
  pid: number
  hostname: string
  /** Host boot time in ms since epoch. See `getBootAt`. */
  bootAt: number
  startedAt: number
}

/**
 * When this host booted. Pid-probing across a reboot is a lie: pids are recycled from a small
 * space, so after a reboot the pid in a stale lockfile is very likely alive again as an
 * unrelated process — and a lock on a persistent path would wedge forever. Comparing boot
 * times tells the two apart.
 */
export function getBootAt(): number {
  return Date.now() - uptime() * 1000
}

export function createLockRecord(): LockRecord {
  return { pid: process.pid, hostname: hostname(), bootAt: getBootAt(), startedAt: Date.now() }
}

export function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    // A non-positive pid is not a holder, it is a weapon: `process.kill(0, sig)` signals the
    // WHOLE process group — the process reading this lockfile included — and `kill(-1, sig)`
    // every process the user may signal. Worse, `kill(0, 0)` succeeds, so such a record would
    // classify as a live holder. Refuse it here, where every reader passes.
    record.pid > 0 &&
    typeof record.hostname === 'string' &&
    record.hostname !== '' &&
    typeof record.bootAt === 'number' &&
    Number.isFinite(record.bootAt) &&
    typeof record.startedAt === 'number' &&
    Number.isFinite(record.startedAt)
  )
}

/**
 * Parse a record, or return null when the content is not a conforming one. Callers treat a
 * corrupt record exactly as they treat a missing file: the holder's liveness is unprovable.
 */
export function parseLockRecord(raw: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isLockRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}
