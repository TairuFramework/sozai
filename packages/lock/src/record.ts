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
  /** Wall-clock claim time in ms since epoch. Ages a holder on a FOREIGN host. See `isStale`. */
  startedAt: number
  /** Host uptime in ms at claim time. Ages a holder on THIS host. See `getUptimeAt`. */
  uptimeAt: number
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

/**
 * How long this host has been up, in milliseconds. MONOTONIC: unlike `Date.now()`, no NTP
 * correction, VM resume, laptop wake or bad RTC can step it. Subtracting a record's `uptimeAt`
 * from ours therefore yields the holder's true age on this host — an age a clock step cannot
 * inflate, which is what stops a forward step from reaping a live holder. It also identifies a
 * reboot exactly: our uptime BELOW the recorded one means the host restarted since the record
 * was written, so its process cannot have survived.
 */
export function getUptimeAt(): number {
  return uptime() * 1000
}

export function createLockRecord(): LockRecord {
  return {
    pid: process.pid,
    hostname: hostname(),
    bootAt: getBootAt(),
    startedAt: Date.now(),
    uptimeAt: getUptimeAt(),
  }
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
    Number.isFinite(record.startedAt) &&
    typeof record.uptimeAt === 'number' &&
    Number.isFinite(record.uptimeAt) &&
    // Uptime runs forward from the boot: a negative one is not a record this package wrote, and
    // it would make every same-host age look larger than it is.
    record.uptimeAt >= 0
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
