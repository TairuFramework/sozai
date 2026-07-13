import { hostname } from 'node:os'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { LockEntry } from '../src/file.js'
import { BOOT_TOLERANCE_MS, checkLiveness, isStale } from '../src/liveness.js'
import { getBootAt, type LockRecord } from '../src/record.js'

function localRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    pid: process.pid,
    hostname: hostname(),
    bootAt: getBootAt(),
    startedAt: Date.now(),
    ...overrides,
  }
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

  test('an unprovable holder is respected until the TTL expires', () => {
    const record = localRecord({ hostname: 'other-host', startedAt: now - 59_000 })
    expect(isStale(entry(record), staleTimeout, now)).toBe(false)
  })

  test('an unprovable holder is stale once the TTL expires', () => {
    const record = localRecord({ hostname: 'other-host', startedAt: now - 61_000 })
    expect(isStale(entry(record), staleTimeout, now)).toBe(true)
  })

  test('a corrupt record is dated by the file mtime, and respected until the TTL expires', () => {
    expect(isStale(entry(null, now - 59_000), staleTimeout, now)).toBe(false)
    expect(isStale(entry(null, now - 61_000), staleTimeout, now)).toBe(true)
  })

  test('a vanished file is stale: there is nothing left to respect', () => {
    expect(isStale({ record: null, inode: null, mtimeMs: null }, staleTimeout, now)).toBe(true)
  })
})
