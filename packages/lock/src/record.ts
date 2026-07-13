import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { hostname, platform, uptime } from 'node:os'

/**
 * The on-disk lock. Carries only what a waiter needs to *prove* the holder is alive —
 * never key material, never caller payload.
 */
export type LockRecord = {
  pid: number
  hostname: string
  /** OS-provided boot identity, or `null` where the platform publishes none. See `checkLiveness`. */
  bootID: string | null
  /** Host boot time in ms since epoch — fallback for `bootID`, clock-step-vulnerable. See `checkLiveness`. */
  bootAt: number
  /** Wall-clock claim time in ms since epoch. Ages a holder on a FOREIGN host. See `isStale`. */
  startedAt: number
  /** Host uptime in ms at claim time. Ages a holder on THIS host. See `getUptimeAt`. */
  uptimeAt: number
}

/** A UUID the kernel regenerates on every boot. Readable by any user. */
const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id'
/** Absolute, so the boot identity never depends on a `PATH` this process does not control. */
const DARWIN_SYSCTL_PATH = '/usr/sbin/sysctl'
/** The darwin equivalent: a UUID regenerated per boot session, unaffected by clock changes. */
const DARWIN_BOOT_ID_OID = 'kern.bootsessionuuid'

/**
 * Outcome of one attempt to read the boot ID. `unsupported` (permanent) and `failed`
 * (transient) must stay distinct — collapsing them into a bare `null` would let a
 * transient failure get cached as if the platform published none. See `getBootID`.
 */
export type BootIDRead =
  | { status: 'ok'; bootID: string }
  | { status: 'unsupported' }
  | { status: 'failed' }

function readSource(raw: string): BootIDRead {
  const bootID = raw.trim()
  // Never an empty string: it would compare EQUAL to another empty one, faking a "same boot" match.
  return bootID === '' ? { status: 'failed' } : { status: 'ok', bootID }
}

/** Reads the current boot ID fresh. NEVER throws — a failed read just costs the `bootAt` fallback. */
export function readBootID(): BootIDRead {
  try {
    switch (platform()) {
      case 'linux':
        return readSource(readFileSync(LINUX_BOOT_ID_PATH, 'utf8'))
      case 'darwin':
        return readSource(
          execFileSync(DARWIN_SYSCTL_PATH, ['-n', DARWIN_BOOT_ID_OID], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 1_000,
          }),
        )
      default:
        return { status: 'unsupported' }
    }
  } catch {
    return { status: 'failed' }
  }
}

/** `undefined` means "not settled yet"; `null` is a boot ID this process does not have. */
let cachedBootID: string | null | undefined
/** Failed reads since the budget was last reset. See `retryBootIDRead`. */
let failedReads = 0
/** Read attempts per acquisition before a failing source settles on `null`. */
const MAX_BOOT_ID_READ_ATTEMPTS = 2

/**
 * The identity of THIS boot, settled and cached once so a `sysctl` spawn never sits in
 * the acquisition loop. The retry budget is spent BEFORE the first caller is answered:
 * a `null` returned here is frozen into a lock record for the life of the hold
 * (`createLockRecord`), so retrying later would be too late.
 */
export function getBootID(): string | null {
  while (cachedBootID === undefined) {
    const read = readBootID()
    switch (read.status) {
      case 'ok':
        cachedBootID = read.bootID
        break
      case 'unsupported':
        cachedBootID = null
        break
      case 'failed':
        failedReads += 1
        if (failedReads >= MAX_BOOT_ID_READ_ATTEMPTS) {
          cachedBootID = null
        }
        break
    }
  }
  return cachedBootID
}

/**
 * Give a FAILING source its budget back so the next acquisition reads it again.
 * Failures only — an unsupported platform's `null` is settled for good, and a boot ID
 * that has already been read is never re-read.
 */
export function retryBootIDRead(): void {
  if (cachedBootID === null && failedReads > 0) {
    cachedBootID = undefined
    failedReads = 0
  }
}

/**
 * When this host booted, derived from the wall clock — NOT safe alone for deciding boot
 * identity: a clock step (NTP, VM resume, wake) moves this without a reboot. Consulted
 * only when no boot ID is available on either side. See `checkLiveness`.
 */
export function getBootAt(): number {
  return Date.now() - uptime() * 1000
}

/**
 * Host uptime in ms. Unlike `Date.now()`, a clock step cannot inflate the age
 * `getUptimeAt() - record.uptimeAt` yields — but it is not portably monotonic: on
 * darwin it can run backwards under a live process that never rebooted. See `isStale`.
 */
export function getUptimeAt(): number {
  return uptime() * 1000
}

/** The record this process writes when it claims the lock. */
export function createLockRecord(): LockRecord {
  return {
    pid: process.pid,
    hostname: hostname(),
    bootID: getBootID(),
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
    // A non-positive pid is a weapon, not a holder: `process.kill(0, sig)` signals the whole
    // process group, `kill(-1, sig)` every process the user may signal, and `kill(0, 0)`
    // succeeds — which would classify such a record as a live holder.
    record.pid > 0 &&
    typeof record.hostname === 'string' &&
    record.hostname !== '' &&
    // `null` is legitimate (no boot ID on this platform). An empty string is not — it would
    // fake a "same boot" match between two failed reads.
    (record.bootID === null || (typeof record.bootID === 'string' && record.bootID !== '')) &&
    typeof record.bootAt === 'number' &&
    Number.isFinite(record.bootAt) &&
    typeof record.startedAt === 'number' &&
    Number.isFinite(record.startedAt) &&
    typeof record.uptimeAt === 'number' &&
    Number.isFinite(record.uptimeAt) &&
    // Uptime runs forward from boot; negative is not a record this package wrote.
    record.uptimeAt >= 0
  )
}

/** Parse a record, or `null` if it does not conform. Callers treat that like a missing file. */
export function parseLockRecord(raw: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isLockRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}
