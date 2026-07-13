import { hostname, uptime } from 'node:os'
import { describe, expect, test } from 'vitest'

import {
  createLockRecord,
  getBootAt,
  getUptimeAt,
  isLockRecord,
  parseLockRecord,
} from '../src/record.js'

function validRecord() {
  return { pid: 123, hostname: 'host-a', bootAt: 1_000, startedAt: 2_000, uptimeAt: 3_000 }
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

describe('createLockRecord()', () => {
  test('describes this process on this host and this boot', () => {
    const record = createLockRecord()
    expect(record.pid).toBe(process.pid)
    expect(record.hostname).toBe(hostname())
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
