import { hostname, uptime } from 'node:os'
import { describe, expect, test } from 'vitest'

import {
  createLockRecord,
  getBootAt,
  getBootID,
  getUptimeAt,
  isLockRecord,
  parseLockRecord,
  readBootID,
} from '../src/record.js'

function validRecord() {
  return {
    pid: 123,
    hostname: 'host-a',
    bootID: 'e6f0c1a2-0000-4000-8000-000000000000',
    bootAt: 1_000,
    startedAt: 2_000,
    uptimeAt: 3_000,
  }
}

describe('getBootAt()', () => {
  test('is in the past and within a plausible uptime window', () => {
    const bootAt = getBootAt()
    expect(bootAt).toBeLessThanOrEqual(Date.now())
    expect(Number.isFinite(bootAt)).toBe(true)
  })

  test('is stable across calls, within a second', () => {
    expect(Math.abs(getBootAt() - getBootAt())).toBeLessThan(1_000)
  })
})

describe('getUptimeAt()', () => {
  test('is the host uptime in milliseconds', () => {
    expect(Math.abs(getUptimeAt() - uptime() * 1000)).toBeLessThan(1_000)
  })

  // A regression guard on the IMPLEMENTATION, not on the platform: it pins that this helper is
  // derived from `os.uptime()` and never from `Date.now()`, so nobody rewrites it in terms of the
  // wall clock and reopens the reap-a-live-holder hole. It cannot test that the host's uptime
  // itself is monotonic — on darwin it is not (`kern.boottime` is adjustable), which is why
  // `isStale` corroborates a negative age instead of trusting it.
  test('is derived from os.uptime(), never from the wall clock', () => {
    const before = getUptimeAt()
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 60 * 60 * 1000
      expect(Math.abs(getUptimeAt() - before)).toBeLessThan(1_000)
    } finally {
      Date.now = realNow
    }
  })
})

describe('getBootID()', () => {
  test('is stable across calls, and never throws on this host', () => {
    expect(getBootID()).toBe(getBootID())
    const read = readBootID()
    expect(getBootID()).toBe(read.status === 'ok' ? read.bootID : null)
  })

  // The two ways of having no boot ID are different facts: a platform that publishes none is
  // settled forever, while a read that FAILED is transient and must not silently downgrade this
  // process to the clock-step-vulnerable `bootAt` fallback for its whole life. On the platforms we
  // ship on, the read succeeds — pinned here against the REAL source, not a mock.
  test.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'reads a real boot ID from the real source on this host',
    () => {
      expect(readBootID()).toEqual({ status: 'ok', bootID: getBootID() })
    },
  )

  test.runIf(process.platform !== 'linux' && process.platform !== 'darwin')(
    'reports an unsupported platform as unsupported, never as a failed read',
    () => {
      expect(readBootID()).toEqual({ status: 'unsupported' })
    },
  )

  // The two platforms this package targets both publish a boot identity that is regenerated on
  // every boot and is immune to the wall clock. Where one is readable, `checkLiveness` never has
  // to fall back to comparing wall-clock-derived boot TIMES — which is what makes a live holder
  // unreapable by a clock step there. Pinned, so nobody silently drops the source for a platform
  // we ship on.
  test.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'is a non-empty string on linux and darwin',
    () => {
      const bootID = getBootID()
      expect(typeof bootID).toBe('string')
      expect(bootID).not.toBe('')
    },
  )
})

describe('createLockRecord()', () => {
  test('describes this process on this host and this boot', () => {
    const record = createLockRecord()
    expect(record.pid).toBe(process.pid)
    expect(record.hostname).toBe(hostname())
    expect(record.bootID).toBe(getBootID())
    expect(Math.abs(record.bootAt - getBootAt())).toBeLessThan(1_000)
    expect(Math.abs(record.startedAt - Date.now())).toBeLessThan(1_000)
    expect(Math.abs(record.uptimeAt - getUptimeAt())).toBeLessThan(1_000)
    expect(isLockRecord(record)).toBe(true)
  })
})

describe('isLockRecord()', () => {
  test('accepts a conforming record', () => {
    expect(isLockRecord(validRecord())).toBe(true)
  })

  // A platform with no boot-ID source writes `null` — a record `checkLiveness` must still accept,
  // and decide by the `bootAt` fallback instead of discarding as corrupt.
  test('accepts a null bootID', () => {
    expect(isLockRecord({ ...validRecord(), bootID: null })).toBe(true)
  })

  test.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
  ])('rejects %s', (_label, value) => {
    expect(isLockRecord(value)).toBe(false)
  })

  // A non-positive pid is not a holder, it is a weapon: process.kill(0, sig) signals the
  // whole process group — the reader included — and kill(-1, sig) everything the user may
  // signal. Refuse it here, where every reader passes.
  test.each([0, -1, -123, 1.5, Number.NaN])('rejects pid %p', (pid) => {
    expect(isLockRecord({ ...validRecord(), pid })).toBe(false)
  })

  test.each([
    ['missing hostname', { pid: 1, bootAt: 1, startedAt: 1 }],
    ['empty hostname', { ...validRecord(), hostname: '' }],
    ['non-string hostname', { ...validRecord(), hostname: 42 }],
    // `undefined` is not `null`: a record with no bootID FIELD is not one this package wrote, and
    // guessing which boot it came from is exactly what must not be guessed.
    ['missing bootID', { pid: 1, hostname: 'h', bootAt: 1, startedAt: 1, uptimeAt: 1 }],
    ['non-string, non-null bootID', { ...validRecord(), bootID: 42 }],
    // An empty boot ID would compare EQUAL to another empty one, manufacturing a "same boot" proof
    // out of two failed reads. Both sides write null instead; refuse the empty string here.
    ['empty bootID', { ...validRecord(), bootID: '' }],
    ['non-finite bootAt', { ...validRecord(), bootAt: Number.POSITIVE_INFINITY }],
    ['missing startedAt', { pid: 1, hostname: 'h', bootAt: 1, uptimeAt: 1 }],
    ['non-finite startedAt', { ...validRecord(), startedAt: Number.NaN }],
    ['missing uptimeAt', { pid: 1, hostname: 'h', bootAt: 1, startedAt: 1 }],
    ['non-finite uptimeAt', { ...validRecord(), uptimeAt: Number.POSITIVE_INFINITY }],
    ['non-number uptimeAt', { ...validRecord(), uptimeAt: '3000' }],
    // Uptime cannot run backwards from the boot: a negative one is not a record we wrote.
    ['negative uptimeAt', { ...validRecord(), uptimeAt: -1 }],
  ])('rejects %s', (_label, value) => {
    expect(isLockRecord(value)).toBe(false)
  })
})

describe('parseLockRecord()', () => {
  test('parses a conforming record', () => {
    expect(parseLockRecord(JSON.stringify(validRecord()))).toEqual(validRecord())
  })

  test.each([
    ['invalid JSON', '{ not json'],
    ['an empty file', ''],
    ['a non-conforming record', JSON.stringify({ pid: 0, hostname: 'h' })],
  ])('returns null for %s', (_label, raw) => {
    expect(parseLockRecord(raw)).toBeNull()
  })
})
