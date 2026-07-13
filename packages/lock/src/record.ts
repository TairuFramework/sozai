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
 * - `failed` is transient — an `EMFILE` under fd pressure, a sandbox that denies the exec, a source
 *   that answers with nothing. Caching THAT as a value silently downgrades the process to the
 *   clock-step-vulnerable `bootAt` fallback for the rest of its life, on a platform whose docs
 *   promise it will not be. See `getBootID` and `retryBootIDRead`.
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

/** `undefined` means "not settled yet"; `null` is a boot ID this process does not have. */
let cachedBootID: string | null | undefined
/**
 * How many times the source has been read and failed since the budget was last reset. Non-zero is
 * also what tells a FAILURE-derived `null` apart from an unsupported platform's, which no retry can
 * change — see `retryBootIDRead`.
 */
let failedReads = 0
/**
 * Reads of the source per ACQUISITION (`retryBootIDRead` resets the count). Two: enough that a
 * source failing non-deterministically is not believed on its first answer, few enough that a
 * permanently-failing one can never put a read — a `sysctl` SPAWN, on darwin — on every turn of the
 * acquisition loop. Both are spent by the FIRST caller (below), so the loop reads a settled cache.
 */
const MAX_BOOT_ID_READ_ATTEMPTS = 2

/**
 * The identity of THIS boot, SETTLED and cached.
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
 * THE RETRY IS SPENT BEFORE THE FIRST CALLER IS ANSWERED, not on the call after it. A `null` handed
 * out here is not a private disappointment: it is written into a lock record, where it is FROZEN for
 * the life of the hold and puts every waiter of that hold on the clock-step-vulnerable fallback
 * (`createLockRecord`), and it is what a liveness decision is then made from (`checkLiveness`). A
 * retry that only paid off on the next call would pay off after the damage — and would hand two
 * callers in one acquisition two different answers.
 *
 * What is cached is a SETTLED answer: an unsupported platform settles on `null` at once (no retry
 * can change what the platform does not publish), a successful read settles on its value, and a
 * source that fails every attempt of the budget settles on `null` FOR THIS ACQUISITION ONLY — see
 * `retryBootIDRead`, which is what stops one unlucky claim from downgrading the process for life.
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
 * `acquireFileLock` calls this before it builds a record, and it is the only real time separation
 * this synchronous path has. The budget's two reads land inside a single tick, so on their own they
 * survive a source that fails NON-DETERMINISTICALLY and nothing more: an `EMFILE` storm, or a macOS
 * App Sandbox denying the `sysctl` spawn, outlasts a tick and fails both. Settling that as the
 * process's answer would put it on the clock-step-vulnerable `bootAt` fallback FOR ITS WHOLE LIFE —
 * on a platform whose docs promise otherwise — over one unlucky claim. Reset per acquisition, the
 * same storm costs a single hold instead, and a process that recovers is picked up by the next lock
 * it takes.
 *
 * FAILURES ONLY. A `null` from an unsupported platform (`failedReads === 0`) is a settled fact about
 * the platform, and re-reading it would put a pointless read in front of every acquisition; a boot
 * ID that HAS been read is never re-read either.
 */
export function retryBootIDRead(): void {
  if (cachedBootID === null && failedReads > 0) {
    cachedBootID = undefined
    failedReads = 0
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

/**
 * The record this process writes when it claims the lock. Its `bootID` is the one thing here that
 * cannot be re-derived later: `pid`, `hostname` and the two clocks are read by every waiter from
 * ITS side, but `bootID` is FROZEN on the record for the life of the hold, and every waiter that
 * evaluates this holder decides from it. Written `null`, it puts that hold — however long it lasts,
 * and however completely this process later recovers a real boot ID — on the fallback path, where a
 * clock step or a hostname change reaps a live holder (`checkLiveness`). So this is where the
 * boot-ID retry is worth spending, and `getBootID` spends it before answering.
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
