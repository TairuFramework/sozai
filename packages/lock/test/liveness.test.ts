import { hostname } from 'node:os'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { LockEntry } from '../src/file.js'
import { BOOT_TOLERANCE_MS, checkLiveness, isStale } from '../src/liveness.js'
import { getBootAt, getUptimeAt, type LockRecord } from '../src/record.js'

function localRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    pid: process.pid,
    hostname: hostname(),
    bootAt: getBootAt(),
    startedAt: Date.now(),
    uptimeAt: getUptimeAt(),
    ...overrides,
  }
}

/** A same-host holder whose pid cannot be probed: our host, but not our boot. */
function unprovableLocalRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return localRecord({
    pid: 999_999,
    bootAt: getBootAt() - 10 * 60 * 60 * 1000,
    ...overrides,
  })
}

function entry(record: LockRecord | null, mtimeMs: number | null = Date.now()): LockEntry {
  return { record, inode: 42, mtimeMs }
}

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

  // After a reboot the recorded pid is very likely alive again as an unrelated process. Probing
  // it would report a live holder and wedge a persistent lockPath forever.
  test('unknown: a boot time outside the tolerance, without probing the pid', () => {
    const kill = vi.spyOn(process, 'kill')
    const record = localRecord({ bootAt: getBootAt() - BOOT_TOLERANCE_MS - 1_000 })
    expect(checkLiveness(record)).toBe('unknown')
    expect(kill).not.toHaveBeenCalled()
  })

  test('alive: a boot time inside the tolerance (clock drift is not a reboot)', () => {
    const record = localRecord({ bootAt: getBootAt() - (BOOT_TOLERANCE_MS - 5_000) })
    expect(checkLiveness(record)).toBe('alive')
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

  // THE design hole this field closes: a forward wall-clock step (NTP, VM resume, laptop wake)
  // larger than the TTL both pushes the record out of the boot tolerance — so liveness reads
  // `unknown` — AND inflates `now - startedAt` past the TTL. One clock step, both halves of the
  // reap condition, and a LIVE holder gets reaped. The same-host age is monotonic instead.
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

  // The host has been up for LESS time than the record claims to have been held: the machine
  // rebooted since it was written, so the holder is definitively gone. No TTL wait.
  test('a same-host holder whose uptime predates ours died in the reboot: stale immediately', () => {
    const record = unprovableLocalRecord({
      startedAt: Date.now(),
      uptimeAt: getUptimeAt() + 60_000,
    })
    expect(isStale(entry(record), staleTimeout)).toBe(true)
  })

  test('a corrupt record is dated by the file mtime, and respected until the TTL expires', () => {
    expect(isStale(entry(null, now - 59_000), staleTimeout, now)).toBe(false)
    expect(isStale(entry(null, now - 61_000), staleTimeout, now)).toBe(true)
  })

  test('a vanished file is stale: there is nothing left to respect', () => {
    expect(isStale({ record: null, inode: null, mtimeMs: null }, staleTimeout, now)).toBe(true)
  })
})
