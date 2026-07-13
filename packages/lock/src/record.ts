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
   * The OS-provided identity of the boot this record was written in, or `null` where the platform
   * publishes none. THE gate on the pid probe, and the load-bearing safety property of this
   * package: a pid only means something within the boot that recorded it, and this is the only way
   * to decide "same boot" that a wall-clock step cannot corrupt. See `getBootID` and
   * `checkLiveness`.
   */
  bootID: string | null
  /**
   * Host boot time in ms since epoch — a FALLBACK for `bootID`, used only when this record or this
   * process has none (an unsupported platform, an unreadable source). Derived from the wall clock,
   * and therefore clock-step-vulnerable: see `getBootAt` and `checkLiveness`.
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
 * The outcome of one attempt to read the boot ID. The two ways of NOT getting one are different
 * facts and must not be collapsed into a bare `null`:
 *
 * - `unsupported` is a permanent property of the platform. Retrying cannot change it.
 * - `failed` is transient — an `EMFILE` at the first claim, a sandbox that denies the exec once, a
 *   source that answers with nothing. Caching THAT as a value silently downgrades the process to
 *   the clock-step-vulnerable `bootAt` fallback for the rest of its life, on a platform whose docs
 *   promise it will not be. See `getBootID`.
 */
export type BootIDRead =
  | { status: 'ok'; bootID: string }
  | { status: 'unsupported' }
  | { status: 'failed' }

function readSource(raw: string): BootIDRead {
  const bootID = raw.trim()
  // Never an empty string: an empty ID would compare EQUAL to another empty one, manufacturing a
  // "same boot" proof out of two failed reads. A supported source that answers with nothing has
  // failed, whatever it thinks it did.
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

/** `undefined` means "not settled yet"; `null` is a boot ID this process will never have. */
let cachedBootID: string | null | undefined
/**
 * How many times the source has been read and failed. Two attempts, ever: enough to survive a
 * transient failure at the first claim, few enough that a permanently-failing source can never put
 * a read — a `sysctl` SPAWN, on darwin — on every turn of the acquisition loop.
 */
let failedReads = 0
const MAX_BOOT_ID_READ_ATTEMPTS = 2

/**
 * The identity of THIS boot, read once and cached.
 *
 * Boot identity gates the pid probe, because pid-probing across a reboot is a lie: pids are
 * recycled from a small space, so after a reboot the pid in a stale lockfile is very likely alive
 * again as an unrelated process — and a lock on a persistent path would wedge forever.
 *
 * It must come from a source the wall clock cannot move (see `getBootAt` for what happens when it
 * does not): a monotonic, OS-provided token, compared for exact equality. Cached because a stale-
 * vs-alive decision happens on every turn of the acquisition loop, and re-reading would put that
 * `sysctl` spawn in the loop.
 *
 * What is cached is a SETTLED answer, never a failure: an unsupported platform settles on `null`
 * immediately (no retry can change what the platform does not publish), a successful read settles
 * on its value, and a FAILED read settles on nothing — it is retried on the next call, once, and
 * only then gives up. Caching a transient failure as `null` would be the whole boot-ID guarantee
 * lost to a single `EMFILE`, silently, for the life of the process.
 */
export function getBootID(): string | null {
  if (cachedBootID !== undefined) {
    return cachedBootID
  }
  const read = readBootID()
  switch (read.status) {
    case 'ok':
      cachedBootID = read.bootID
      return cachedBootID
    case 'unsupported':
      cachedBootID = null
      return null
    case 'failed':
      failedReads += 1
      if (failedReads >= MAX_BOOT_ID_READ_ATTEMPTS) {
        cachedBootID = null
      }
      return null
  }
}

/**
 * When this host booted, derived from the wall clock — and therefore NOT a safe way to decide boot
 * identity on its own. A forward wall-clock step (NTP, VM resume, laptop wake) moves this without
 * any reboot, so a LIVE holder's recorded `bootAt` stops matching ours, its pid is never probed,
 * and the TTL reaps it: two processes in the critical section. That is why `bootID` exists, and why
 * this value is consulted only where no boot ID is available on either side. See `checkLiveness`.
 */
export function getBootAt(): number {
  return Date.now() - uptime() * 1000
}

/**
 * How long this host has been up, in milliseconds. Unlike `Date.now()`, it does not move with the
 * wall clock: an NTP correction, a VM resume, a laptop wake or a bad RTC cannot INFLATE the age
 * that `getUptimeAt() - record.uptimeAt` yields, which is what stops a forward clock step from
 * reaping a live holder.
 *
 * NOT portably monotonic, though, and `isStale` is written for that: on darwin `uv_uptime` is
 * `time(NULL) - kern.boottime`, and the kernel adjusts `kern.boottime` on clock and sleep events —
 * so this can run backwards under a live process, on a host that never rebooted. A negative age is
 * therefore a reboot SIGNAL, corroborated against the wall clock before anything is reaped, not a
 * reboot proof. See `isStale`.
 */
export function getUptimeAt(): number {
  return uptime() * 1000
}

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
    // `null` is legitimate — a platform that publishes no boot ID, decided by the `bootAt` fallback
    // instead. An EMPTY STRING is not: it would compare equal to another empty one and fabricate a
    // "same boot" proof from two failed reads. A MISSING field is not either: `undefined` is not a
    // record this package wrote, and which boot it came from is precisely what must not be guessed.
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
