import { hostname } from 'node:os'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { LockEntry } from '../src/file.js'
import { BOOT_TOLERANCE_MS, checkLiveness, isStale } from '../src/liveness.js'
import { getBootAt, getUptimeAt, type LockRecord } from '../src/record.js'

/**
 * The boot-ID SOURCE is mocked, never the host's real one: these assertions must hold identically
 * on a linux runner, on a darwin laptop, and — through `null` — on a platform that publishes no
 * boot ID at all. `src/record.js` keeps its real `getBootAt`/`getUptimeAt`.
 */
const { ourBootID } = vi.hoisted(() => ({ ourBootID: { value: null as string | null } }))
vi.mock('../src/record.js', async () => {
  const actual = await vi.importActual<typeof import('../src/record.js')>('../src/record.js')
  return { ...actual, getBootID: () => ourBootID.value }
})

const OUR_BOOT_ID = 'e6f0c1a2-0000-4000-8000-thisboot'
const PREVIOUS_BOOT_ID = 'e6f0c1a2-0000-4000-8000-lastboot'

function localRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    pid: process.pid,
    hostname: hostname(),
    bootID: ourBootID.value,
    bootAt: getBootAt(),
    startedAt: Date.now(),
    uptimeAt: getUptimeAt(),
    ...overrides,
  }
}

/**
 * A same-host holder whose pid cannot be probed: our host, but not our boot. Unprovable by the boot
 * ID (a different one) AND by the `bootAt` fallback (far outside the tolerance), so it reads
 * `unknown` on either path — which is what makes it the fixture for every age rule below.
 */
function unprovableLocalRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return localRecord({
    pid: 999_999,
    bootID: PREVIOUS_BOOT_ID,
    bootAt: getBootAt() - 10 * 60 * 60 * 1000,
    ...overrides,
  })
}

function entry(record: LockRecord | null, mtimeMs: number | null = Date.now()): LockEntry {
  return { record, inode: 42, mtimeMs }
}

beforeEach(() => {
  ourBootID.value = OUR_BOOT_ID
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('checkLiveness()', () => {
  test('alive: our own live pid, same host, same boot', () => {
    expect(checkLiveness(localRecord())).toBe('alive')
  })

  test('dead: a pid that no longer exists', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('no such process')
      err.code = 'ESRCH'
      throw err
    })
    expect(checkLiveness(localRecord({ pid: 999_999 }))).toBe('dead')
  })

  // The process exists, it simply belongs to another user. That is a live holder.
  test('alive: EPERM from the probe', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('operation not permitted')
      err.code = 'EPERM'
      throw err
    })
    expect(checkLiveness(localRecord({ pid: 1 }))).toBe('alive')
  })

  test('unknown: a foreign hostname, without probing the pid', () => {
    const kill = vi.spyOn(process, 'kill')
    expect(checkLiveness(localRecord({ hostname: 'some-other-host' }))).toBe('unknown')
    expect(kill).not.toHaveBeenCalled()
  })

  test('matching boot IDs: the pid IS probed', () => {
    const kill = vi.spyOn(process, 'kill')
    expect(checkLiveness(localRecord({ bootID: OUR_BOOT_ID }))).toBe('alive')
    expect(kill).toHaveBeenCalledWith(process.pid, 0)
  })

  // After a reboot the recorded pid is very likely alive again as an unrelated process. Probing
  // it would report a live holder and wedge a persistent lockPath forever.
  test('differing boot IDs: unknown, without probing the pid', () => {
    const kill = vi.spyOn(process, 'kill')
    expect(checkLiveness(localRecord({ bootID: PREVIOUS_BOOT_ID }))).toBe('unknown')
    expect(kill).not.toHaveBeenCalled()
  })

  // THE property that closes the reap-a-live-holder hole. The wall clock steps forward by five
  // minutes (NTP, VM resume, laptop wake): every wall-clock-derived boot TIME moves with it, and
  // the old `bootAt` tolerance therefore declared a LIVE holder unprovable, skipped its pid probe,
  // and let the TTL reap it. An OS boot ID does not move with the clock, so the probe still runs
  // and still finds the holder alive.
  test('matching boot IDs survive a wall-clock step that blows the bootAt tolerance apart', () => {
    const record = localRecord({
      bootID: OUR_BOOT_ID,
      bootAt: getBootAt() - 300_000,
    })
    expect(Math.abs(record.bootAt - getBootAt())).toBeGreaterThan(BOOT_TOLERANCE_MS)
    expect(checkLiveness(record)).toBe('alive')
  })

  describe('the bootAt fallback, where no boot ID is available', () => {
    // Only reachable when a boot ID is missing on one side or the other — an unsupported platform,
    // or a record written by a process that could not read one. It is clock-step-vulnerable by
    // construction, which is exactly why it is a fallback and not the rule.
    test.each([
      ['the record has no boot ID', OUR_BOOT_ID, null],
      ['this process has no boot ID', null, PREVIOUS_BOOT_ID],
      ['neither side has one', null, null],
    ])('%s: a boot time outside the tolerance is unknown, and the pid is not probed', (_label, processBootID, recordBootID) => {
      ourBootID.value = processBootID
      const kill = vi.spyOn(process, 'kill')
      const record = localRecord({
        bootID: recordBootID,
        bootAt: getBootAt() - BOOT_TOLERANCE_MS - 1_000,
      })
      expect(checkLiveness(record)).toBe('unknown')
      expect(kill).not.toHaveBeenCalled()
    })

    test.each([
      ['the record has no boot ID', OUR_BOOT_ID, null],
      ['this process has no boot ID', null, PREVIOUS_BOOT_ID],
      ['neither side has one', null, null],
    ])('%s: a boot time inside the tolerance is probed (clock drift is not a reboot)', (_label, processBootID, recordBootID) => {
      ourBootID.value = processBootID
      const record = localRecord({
        bootID: recordBootID,
        bootAt: getBootAt() - (BOOT_TOLERANCE_MS - 5_000),
      })
      expect(checkLiveness(record)).toBe('alive')
    })
  })
})

describe('isStale()', () => {
  const now = 1_000_000
  const staleTimeout = 60_000

  test('a provably-live holder is never stale, however long it has held', () => {
    const record = localRecord({ startedAt: now - 24 * 60 * 60 * 1000 })
    expect(isStale(entry(record), staleTimeout, now)).toBe(false)
  })

  test('a provably-dead holder is stale immediately, whatever the TTL', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('no such process')
      err.code = 'ESRCH'
      throw err
    })
    const record = localRecord({ pid: 999_999, startedAt: now })
    expect(isStale(entry(record), staleTimeout, now)).toBe(true)
  })

  test('a provably-live holder is never stale, whatever its recorded uptime claims', () => {
    const record = localRecord({
      startedAt: now - 24 * 60 * 60 * 1000,
      uptimeAt: getUptimeAt() + 60_000,
    })
    expect(isStale(entry(record), staleTimeout, now)).toBe(false)
  })

  test('an unprovable foreign holder is respected until the TTL expires', () => {
    const record = localRecord({ hostname: 'other-host', startedAt: now - 59_000 })
    expect(isStale(entry(record), staleTimeout, now)).toBe(false)
  })

  test('an unprovable foreign holder is stale once the TTL expires', () => {
    const record = localRecord({ hostname: 'other-host', startedAt: now - 61_000 })
    expect(isStale(entry(record), staleTimeout, now)).toBe(true)
  })

  // We cannot read another host's uptime, so a foreign record is aged by the wall clock however
  // fresh its recorded uptime looks. Documented, and the reason cross-host use is unsupported.
  test('a foreign holder is aged by the wall clock, never by its recorded uptime', () => {
    const record = localRecord({
      hostname: 'other-host',
      startedAt: now - 61_000,
      uptimeAt: getUptimeAt(),
    })
    expect(isStale(entry(record), staleTimeout, now)).toBe(true)
  })

  /**
   * THE reviewer's repro, and the reason `bootID` exists. Our own host, our own LIVE pid, a genuine
   * 61s hold, and a +300s wall-clock step — against a 60s TTL:
   *
   * - the step moved our `getBootAt()` 300s away from the record's, so the OLD boot-tolerance check
   *   declared this live holder unprovable and never probed its pid;
   * - the monotonic age was correct at 61s and uninflated — and 61s > 60s, so the TTL reaped it.
   *
   * `uptimeAt` stopped the step from INFLATING the age; it did nothing about the step destroying
   * the liveness PROOF. Two processes in the critical section, two keys generated, one silently
   * lost. The boot ID does not move with the clock: the pid is probed, the holder is alive, and an
   * alive holder is never stale.
   */
  test("the reviewer's repro: a LIVE holder survives a +300s clock step at 61s of hold", () => {
    const record = localRecord({
      pid: process.pid, // real, and alive: this very process
      bootID: OUR_BOOT_ID, // same boot — unmoved by the clock step
      bootAt: getBootAt() - 300_000, // wall-clock-derived, and the step moved ours 300s away
      startedAt: Date.now() - 361_000, // 61s of hold + the 300s the clock jumped
      uptimeAt: getUptimeAt() - 61_000, // the TRUE, monotonic age: 61s
    })

    expect(Math.abs(record.bootAt - getBootAt())).toBeGreaterThan(BOOT_TOLERANCE_MS)
    expect(checkLiveness(record)).toBe('alive')
    expect(isStale(entry(record), staleTimeout)).toBe(false)
  })

  // The same guarantee where NO boot ID is readable (an unsupported platform): the liveness proof
  // is lost to the clock step, but the monotonic age still holds the line — the holder is respected
  // until its REAL age reaches the TTL, not its apparent one.
  test('a forward wall-clock step does not make a same-host holder stale', () => {
    const record = unprovableLocalRecord({
      startedAt: Date.now() - 60 * 60 * 1000,
      uptimeAt: getUptimeAt(),
    })
    expect(isStale(entry(record), staleTimeout)).toBe(false)
  })

  test('a same-host holder is respected until its MONOTONIC age reaches the TTL', () => {
    const record = unprovableLocalRecord({
      startedAt: Date.now() - 24 * 60 * 60 * 1000,
      uptimeAt: getUptimeAt() - (staleTimeout - 5_000),
    })
    expect(isStale(entry(record), staleTimeout)).toBe(false)
  })

  test('a same-host holder is stale once its monotonic age exceeds the TTL', () => {
    const record = unprovableLocalRecord({
      startedAt: Date.now(),
      uptimeAt: getUptimeAt() - (staleTimeout + 1_000),
    })
    expect(isStale(entry(record), staleTimeout)).toBe(true)
  })

  // The host has been up for LESS time than the record claims to have been held. A real reboot
  // produces that — and a real reboot also has real downtime, so the record's wall-clock claim
  // time is well in the past. Both halves hold: the holder is definitively gone.
  test('a same-host holder whose uptime predates ours, with the downtime a reboot leaves, is stale', () => {
    const record = unprovableLocalRecord({
      startedAt: Date.now() - (staleTimeout + 60_000),
      uptimeAt: getUptimeAt() + 60_000,
    })
    expect(isStale(entry(record), staleTimeout)).toBe(true)
  })

  // ...but a reboot is not the only thing that makes `os.uptime()` run backwards. On darwin it is
  // not portably monotonic: `uv_uptime` is `time(NULL) - kern.boottime`, and the kernel adjusts
  // `kern.boottime` on clock and sleep events. A forward `boottime` bump larger than
  // BOOT_TOLERANCE_MS produces a boot mismatch (→ `unknown`, the pid probe is skipped) AND a
  // negative age — together, on a LIVE holder. Corroboration from the wall clock tells the two
  // apart: no reboot leaves a holder that claimed the lock seconds ago.
  test('a same-host holder claimed seconds ago is NOT reaped when the uptime merely ran backwards', () => {
    const record = unprovableLocalRecord({
      startedAt: Date.now() - 5_000,
      uptimeAt: getUptimeAt() + 60_000,
    })
    expect(isStale(entry(record), staleTimeout)).toBe(false)
  })

  // Corroborating a reboot against `now - startedAt > staleTimeout` alone WEDGES the lock on a host
  // whose clock runs BACKWARDS past the record: a bad RTC on a Pi, a container booting to 1970
  // before NTP lands. `now - startedAt` is then permanently negative, never exceeds the TTL, and a
  // genuinely-dead post-reboot holder is never reaped — the lock is held by nobody, forever. A
  // record dated in the FUTURE is corroboration a live holder cannot manufacture: it claimed the
  // lock at a wall-clock instant that, from here, has not happened yet.
  test('a dead post-reboot holder is still reaped when the wall clock has run backwards past it', () => {
    const record = unprovableLocalRecord({
      startedAt: now + 60 * 60 * 1000, // the clock went back an hour under a record from "the future"
      uptimeAt: getUptimeAt() + 60_000, // uptime below ours: the reboot signal
    })
    expect(isStale(entry(record), staleTimeout, now)).toBe(true)
  })

  // Not every reboot has downtime worth the name. A container restart or a kexec can be back inside
  // seconds, and where hold + downtime + the new boot's uptime is still under the TTL, the wall
  // clock cannot yet corroborate the reboot — so the record is respected until the TTL expires.
  // Reap LATENCY, bounded by the TTL, never a wedge and never an exclusion hole. Pinned here rather
  // than assumed away: the docs used to claim corroboration "costs a real reboot nothing", and for
  // a fast reboot that is simply false.
  test('a fast reboot (seconds of downtime) is reaped by the TTL, not at once', () => {
    // Held 3s into the old boot, 2s of downtime, we are now 5s into the new one: 10s of wall clock
    // in total, against a 60s TTL.
    const record = unprovableLocalRecord({
      startedAt: now - 10_000,
      uptimeAt: getUptimeAt() + 3_000, // the old boot had been up longer than this one has
    })

    expect(isStale(entry(record), staleTimeout, now)).toBe(false)
    // ...and reaped once the TTL has elapsed since the claim, with nothing else having changed.
    expect(isStale(entry(record), staleTimeout, now + 51_000)).toBe(true)
  })

  test('a corrupt record is dated by the file mtime, and respected until the TTL expires', () => {
    expect(isStale(entry(null, now - 59_000), staleTimeout, now)).toBe(false)
    expect(isStale(entry(null, now - 61_000), staleTimeout, now)).toBe(true)
  })

  test('a vanished file is stale: there is nothing left to respect', () => {
    expect(isStale({ record: null, inode: null, mtimeMs: null }, staleTimeout, now)).toBe(true)
  })
})
