import { describe, expect, test } from 'vitest'

import { HLC } from '../src/index.js'

describe('HLC.tryParse', () => {
  test('accepts what serialize emits', () => {
    const ts = { wallTime: 1739539800000, counter: 42, nodeID: 'did:key:z6Mk123' }
    expect(HLC.tryParse(HLC.serialize(ts))).toEqual(ts)
  })

  test('rejects a stamp whose wall time is unparseable while its counter is not', () => {
    // The shape a one-field check misses. Without a `Z` the wall time is NaN,
    // but the digits after it still parse to a finite counter — so a guard
    // written on `counter` alone lets this through and `receive` carries the NaN
    // wall time into the device clock.
    const partial = HLC.parse('1754825192341')
    expect(Number.isNaN(partial.wallTime)).toBe(true)
    expect(Number.isFinite(partial.counter)).toBe(true)

    expect(HLC.tryParse('1754825192341')).toBeNull()
  })

  test('rejects a stamp with no usable field at all', () => {
    expect(HLC.tryParse('zzz')).toBeNull()
    expect(HLC.tryParse('')).toBeNull()
    expect(HLC.tryParse('not-a-timestamp')).toBeNull()
  })

  test('rejects a well-formed wall time whose counter is not a number', () => {
    expect(HLC.tryParse('2026-01-01T00:00:00.000Z:notacounter:node')).toBeNull()
  })

  test('rejects an empty node id', () => {
    // `nodeID` is the last tie-break in `compare`, so an empty one silently
    // makes two distinct writers compare equal.
    expect(HLC.tryParse('2026-01-01T00:00:00.000Z:00000001:')).toBeNull()
  })

  test('a rejected stamp never reaches the clock', () => {
    const clock = new HLC({ nodeID: 'local' })
    clock.now()

    const parsed = HLC.tryParse('zzz')
    if (parsed != null) {
      clock.receive(parsed)
    }

    const ts = clock.now()
    expect(Number.isFinite(ts.counter)).toBe(true)
    expect(HLC.serialize(ts)).not.toContain('NaN')
  })
})
