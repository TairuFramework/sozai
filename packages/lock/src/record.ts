import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { hostname, platform, uptime } from 'node:os'

/**
 * The on-disk lock. It carries what a waiter needs to *prove* the holder is alive, and
 * nothing else — never key material, never caller payload. Whatever the lock guards stays
 * in the store the lock guards.
 */
export type LockRecord = {
  pid: number
  hostname: string
  /**
   * OS-provided identity of the boot this record was written in, or `null` where the platform
   * publishes none — the gate on the pid probe, chosen because a wall-clock step cannot corrupt
   * it. See `getBootID` and `checkLiveness`.
   */
  bootID: string | null
  /**
   * Host boot time in ms since epoch — a FALLBACK for `bootID`, used only when this record or this
   * process has none. Derived from the wall clock, and therefore clock-step-vulnerable: see
   * `getBootAt` and `checkLiveness`.
   */
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
 * The outcome of one attempt to read the boot ID. The two ways of NOT getting one must not be
 * collapsed into a bare `null`: `unsupported` is a permanent property of the platform (retrying
 * cannot change it), while `failed` is transient (an `EMFILE`, a sandbox denying the exec).
 * Caching a `failed` read as a value would silently downgrade the process to the clock-step-
 * vulnerable `bootAt` fallback for the rest of its life. See `getBootID` and `retryBootIDRead`.
 */
export type BootIDRead =
  | { status: 'ok'; bootID: string }
  | { status: 'unsupported' }
  | { status: 'failed' }

function readSource(raw: string): BootIDRead {
  const bootID = raw.trim()
  // Never an empty string: it would compare EQUAL to another empty one, manufacturing a "same
  // boot" proof out of two failed reads.
  return bootID === '' ? { status: 'failed' } : { status: 'ok', bootID }
}

/**
 * The OS-provided identity of the current boot, read fresh. `getBootID` is what callers want; this
 * exists to be read once, and to be testable.
 *
 * NEVER throws, on any platform, for any reason. A boot ID that cannot be read costs the fallback
 * comparison in `checkLiveness`; a boot ID that THREW would fail the lock claim itself.
 */
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
/**
 * Reads since the budget was last reset. Non-zero is what tells a FAILURE-derived `null` apart
 * from an unsupported platform's, which no retry can change — see `retryBootIDRead`.
 */
let failedReads = 0
/**
 * Reads of the source per ACQUISITION (`retryBootIDRead` resets the count). Two: enough that a
 * non-deterministic failure is not believed on its first answer, few enough that a
 * permanently-failing source (a `sysctl` SPAWN, on darwin) never lands a read on every turn of the
 * acquisition loop — both are spent by the first caller, so the loop reads a settled cache.
 */
const MAX_BOOT_ID_READ_ATTEMPTS = 2

/**
 * The identity of THIS boot, settled and cached: boot identity gates the pid probe (pids are
 * recycled from a small space, so a stale lockfile's pid is likely alive again post-reboot as an
 * unrelated process), and re-reading on every turn of the acquisition loop would put a `sysctl`
 * spawn in that loop.
 *
 * The retry budget is spent BEFORE the first caller is answered, not on a later call: a `null`
 * returned here gets written into a lock record and FROZEN there for the life of the hold
 * (`createLockRecord`), so a retry that only paid off next time would pay off after the damage,
 * and could hand two callers in one acquisition two different answers.
 *
 * `unsupported` settles on `null` at once (no retry changes what a platform does not publish); a
 * source that fails every attempt of the budget settles on `null` FOR THIS ACQUISITION ONLY — see
 * `retryBootIDRead`.
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
 * Give a FAILING source its budget back, so the next acquisition reads it again.
 *
 * `acquireFileLock` calls this before it builds a record — the only real time separation this
 * synchronous path has. The budget's two reads land inside a single tick, so on their own they
 * survive only a NON-deterministic failure; a sustained one (an `EMFILE` storm, a macOS App
 * Sandbox denying the `sysctl` spawn) outlasts a tick and fails both. Resetting per acquisition
 * means such a storm costs one hold instead of downgrading the process to the `bootAt` fallback
 * for its whole life.
 *
 * FAILURES ONLY: a `null` from an unsupported platform (`failedReads === 0`) is a settled fact, and
 * a boot ID that HAS been read is never re-read either.
 */
export function retryBootIDRead(): void {
  if (cachedBootID === null && failedReads > 0) {
    cachedBootID = undefined
    failedReads = 0
  }
}

/**
 * When this host booted, derived from the wall clock — NOT safe alone for deciding boot identity:
 * a forward step (NTP, VM resume, laptop wake) moves this without a reboot, so a live holder's
 * recorded `bootAt` stops matching, its pid is never probed, and the TTL reaps it. Consulted only
 * where no boot ID is available on either side. See `checkLiveness`.
 */
export function getBootAt(): number {
  return Date.now() - uptime() * 1000
}

/**
 * How long this host has been up, in milliseconds. Unlike `Date.now()`, a clock step cannot
 * INFLATE the age `getUptimeAt() - record.uptimeAt` yields.
 *
 * NOT portably monotonic, though: on darwin `uv_uptime` is `time(NULL) - kern.boottime`, and the
 * kernel adjusts `kern.boottime` on clock and sleep events, so this can run backwards under a live
 * process that never rebooted. See `isStale` for how a negative age is corroborated rather than
 * trusted as reboot proof.
 */
export function getUptimeAt(): number {
  return uptime() * 1000
}

/**
 * The record this process writes when it claims the lock. `bootID` is FROZEN here for the life of
 * the hold — unlike the other fields, no waiter re-derives it from its own side — so this is where
 * the boot-ID retry is worth spending, and `getBootID` spends it before answering.
 */
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
    // A non-positive pid is not a holder, it is a weapon: `process.kill(0, sig)` signals the
    // WHOLE process group — the process reading this lockfile included — and `kill(-1, sig)`
    // every process the user may signal. Worse, `kill(0, 0)` succeeds, so such a record would
    // classify as a live holder. Refuse it here, where every reader passes.
    record.pid > 0 &&
    typeof record.hostname === 'string' &&
    record.hostname !== '' &&
    // `null` is legitimate (a platform with no boot ID, decided by the `bootAt` fallback instead).
    // An empty string is not: it would compare equal to another empty one and fabricate a "same
    // boot" proof from two failed reads. A missing field (`undefined`) is not a record this
    // package wrote.
    (record.bootID === null || (typeof record.bootID === 'string' && record.bootID !== '')) &&
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
