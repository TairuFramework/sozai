import { hostname } from 'node:os'
import { describe, expect, test } from 'vitest'

import { createLockRecord, getBootAt, isLockRecord, parseLockRecord } from '../src/record.js'

function validRecord() {
  return { pid: 123, hostname: 'host-a', bootAt: 1_000, startedAt: 2_000 }
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

describe('createLockRecord()', () => {
  test('describes this process on this host and this boot', () => {
    const record = createLockRecord()
    expect(record.pid).toBe(process.pid)
    expect(record.hostname).toBe(hostname())
    expect(Math.abs(record.bootAt - getBootAt())).toBeLessThan(1_000)
    expect(Math.abs(record.startedAt - Date.now())).toBeLessThan(1_000)
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
    ['missing startedAt', { pid: 1, hostname: 'h', bootAt: 1 }],
    ['non-finite startedAt', { ...validRecord(), startedAt: Number.NaN }],
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
