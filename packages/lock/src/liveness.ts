import { hostname } from 'node:os'

import type { LockEntry } from './file.js'
import { getBootAt, getBootID, getUptimeAt, type LockRecord } from './record.js'

/**
 * How far the recorded boot TIME may drift from ours and still describe the same boot — the
 * tolerance of the FALLBACK comparison only (see `isSameBoot`). `os.uptime()` and `Date.now()`
 * diverge under NTP correction, so the comparison needs slack.
 */
export const BOOT_TOLERANCE_MS = 30_000

export type Liveness = 'alive' | 'dead' | 'unknown'

/**
 * Did this record come from the boot we are running in? The pid probe below is gated on it, so
 * getting it wrong is not a nuance — it is the whole safety property, and it fails in both
 * directions:
 *
 * - say "different boot" about a LIVE holder and its pid is never probed, so the TTL reaps it and
 *   two processes enter the critical section;
 * - say "same boot" about a holder from a PREVIOUS boot and its recycled pid answers `kill(pid, 0)`
 *   as somebody else entirely, so a persistent `lockPath` wedges forever.
 *
 * THE TRADE-OFF, WRITTEN DOWN SO IT IS NOT "FIXED" BACK: boot identity must come from a monotonic,
 * clock-independent source. Deciding it from the WALL CLOCK — which is what comparing `bootAt`
 * values (`Date.now() - os.uptime() * 1000`) does — cannot be made safe by tuning the tolerance,
 * because it trades one of those failures against the other with no safe side:
 *
 * - a TIGHT tolerance reaps live holders. A forward step larger than it (NTP correction, VM resume,
 *   laptop wake, a bad RTC) moves our `bootAt` away from a live holder's without any reboot. The
 *   macOS keychain prompt this package exists for can hold the section for minutes, and laptop
 *   sleep/wake supplies the step.
 * - a WIDE tolerance wedges on a recycled pid. A reboot within the tolerance leaves a `bootAt` that
 *   still "matches", so a dead holder's pid is probed and its recycled owner reports alive.
 *
 * An OS boot ID has neither failure: it does not move when the clock does, and it always changes
 * across a reboot. So compare boot IDs exactly whenever both sides have one. The `bootAt` tolerance
 * survives ONLY as the fallback for a platform that publishes no boot ID (or a record written by a
 * process that could not read one), where the trade above is unavoidable — and there the residual
 * is real: a clock step larger than the tolerance still costs a live holder its liveness PROOF. It
 * no longer costs it the LOCK, because the same-host age is monotonic (`isStale`), so the step
 * cannot also inflate the age past the TTL — but on those platforms this is a two-lock design, not
 * a one-lock one.
 */
function isSameBoot(record: LockRecord): boolean {
  const bootID = getBootID()
  if (bootID !== null && record.bootID !== null) {
    // Both sides know which boot they are from. Nothing else is consulted: an exact match is proof,
    // however far apart the two wall-clock-derived `bootAt` values have drifted.
    return record.bootID === bootID
  }
  return Math.abs(record.bootAt - getBootAt()) <= BOOT_TOLERANCE_MS
}

/**
 * Liveness is proven, never assumed. A pid is only meaningful on the host that recorded it and
 * within the boot that recorded it: across hosts, and across a reboot, the same number belongs
 * to somebody else.
 */
export function checkLiveness(record: LockRecord): Liveness {
  if (record.hostname !== hostname()) {
    return 'unknown'
  }
  if (!isSameBoot(record)) {
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
 * - SAME HOST: monotonically, from `uptimeAt`. No wall-clock step can INFLATE that age. Together
 *   with the boot ID in `checkLiveness` — which no clock step can move either — that is what makes
 *   a live holder unreapable: the step can neither suppress its liveness proof nor age it out.
 *   A NEGATIVE age — this host has been up for less time than the record claims to have been held —
 *   is the reboot signal, but it is not a reboot PROOF: `os.uptime()` is not portably monotonic (on
 *   darwin it is `time(NULL) - kern.boottime`, and the kernel adjusts `kern.boottime` on clock and
 *   sleep events), so a forward `boottime` bump can hand a live holder a negative age. So the
 *   reboot verdict is CORROBORATED before anything is reaped, by either of the two things a live
 *   holder cannot produce:
 *     1. a claim older than the TTL (`now - startedAt > staleTimeout`), or
 *     2. a claim from the FUTURE (`now < startedAt`) — required because a host whose clock runs
 *        BACKWARDS past the record (a bad RTC, a container booted to 1970 before NTP lands) makes
 *        `now - startedAt` permanently negative, so (1) alone would never fire and a dead
 *        post-reboot holder would wedge the lock forever.
 * - FOREIGN HOST, or a record too corrupt to carry an uptime (dated, then, by the file's own
 *   mtime): the wall clock is all there is, because another host's uptime is unreadable to us.
 *   A clock step on EITHER machine can therefore still expire such a record early. Unavoidable,
 *   and the reason cross-host locking is not supported. (A future-dated FOREIGN record is left
 *   alone: two hosts' clocks legitimately disagree, and there is no reboot signal there to
 *   corroborate — only the claim itself, which is exactly what a live remote holder writes.)
 *
 * REBOOT RECOVERY IS TTL-BOUNDED, ALWAYS — the earlier claim that "a reboot always has real
 * downtime, so corroboration costs a real reboot nothing" was false, and is retracted:
 *
 * - a holder that claimed the lock seconds into a boot, followed by a reboot, leaves a record whose
 *   `uptimeAt` sits BELOW the new boot's current uptime: a small POSITIVE age, no reboot signal at
 *   all, respected until the age reaches the TTL;
 * - a FAST reboot (a container restart, a kexec — seconds of downtime), where hold + downtime + the
 *   new uptime is still under the TTL, does produce the negative age but cannot corroborate it yet,
 *   so it too waits out the TTL.
 *
 * Both are reap LATENCY bounded by the TTL, never an exclusion hole and never a wedge. And the
 * latency is inherent: from the wall clock alone a reboot and a forward clock step are
 * indistinguishable, which is why the wall clock cannot be the thing that decides.
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
        // holder. Corroborate with what a live holder cannot produce — a claim older than the TTL,
        // or a claim dated in the future (which is what a BACKWARDS clock leaves behind, and
        // without which such a host never reaps this record at all).
        return now < record.startedAt || now - record.startedAt > staleTimeout
      }
      return age > staleTimeout
    }
  }
}
