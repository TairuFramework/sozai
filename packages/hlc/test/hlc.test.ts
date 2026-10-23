import { describe, expect, test } from 'vitest'

import { HLC, type HLCTimestamp } from '../src/index.js'

describe('HLC', () => {
  test('now() returns a valid timestamp', () => {
    const clock = new HLC({ nodeID: 'did:key:test1' })
    const ts = clock.now()
    expect(ts.wallTime).toBeGreaterThan(0)
    expect(ts.counter).toBe(0)
    expect(ts.nodeID).toBe('did:key:test1')
  })

  test('now() is monotonically increasing', () => {
    const clock = new HLC({ nodeID: 'did:key:test1' })
    const ts1 = clock.now()
    const ts2 = clock.now()
    expect(HLC.compare(ts2, ts1)).toBeGreaterThan(0)
  })

  test('now() increments counter when wall time is unchanged', () => {
    const clock = new HLC({ nodeID: 'did:key:test1' })
    const ts1 = clock.now()
    const ts2 = clock.now()
    if (ts2.wallTime === ts1.wallTime) {
      expect(ts2.counter).toBe(ts1.counter + 1)
    } else {
      expect(ts2.wallTime).toBeGreaterThan(ts1.wallTime)
    }
  })

  test('receive() advances clock past remote timestamp', () => {
    const clock = new HLC({ nodeID: 'did:key:local' })
    const futureTime = Date.now() + 10_000
    const remote: HLCTimestamp = { wallTime: futureTime, counter: 5, nodeID: 'did:key:remote' }

    const ts = clock.receive(remote)
    expect(ts.wallTime).toBe(futureTime)
    expect(ts.counter).toBe(6)
    expect(ts.nodeID).toBe('did:key:local')

    const next = clock.now()
    expect(HLC.compare(next, remote)).toBeGreaterThan(0)
  })

  test('receive() uses local wall time when it is ahead', () => {
    const clock = new HLC({ nodeID: 'did:key:local' })
    const pastTime = Date.now() - 10_000
    const remote: HLCTimestamp = { wallTime: pastTime, counter: 0, nodeID: 'did:key:remote' }

    const ts = clock.receive(remote)
    expect(ts.wallTime).toBeGreaterThanOrEqual(Date.now() - 100)
  })

  test('serialize() and parse() round-trip', () => {
    const ts: HLCTimestamp = { wallTime: 1739539800000, counter: 42, nodeID: 'did:key:z6Mk123' }
    const str = HLC.serialize(ts)
    const parsed = HLC.parse(str)
    expect(parsed).toEqual(ts)
  })

  test('serialized timestamps sort lexicographically', () => {
    const ts1: HLCTimestamp = { wallTime: 1739539800000, counter: 0, nodeID: 'did:key:aaa' }
    const ts2: HLCTimestamp = { wallTime: 1739539800001, counter: 0, nodeID: 'did:key:aaa' }
    const ts3: HLCTimestamp = { wallTime: 1739539800001, counter: 1, nodeID: 'did:key:aaa' }

    const s1 = HLC.serialize(ts1)
    const s2 = HLC.serialize(ts2)
    const s3 = HLC.serialize(ts3)

    expect(s1 < s2).toBe(true)
    expect(s2 < s3).toBe(true)
  })

  test('compare() orders by wallTime, then counter, then nodeID', () => {
    const a: HLCTimestamp = { wallTime: 1000, counter: 0, nodeID: 'a' }
    const b: HLCTimestamp = { wallTime: 1000, counter: 1, nodeID: 'a' }
    const c: HLCTimestamp = { wallTime: 1000, counter: 1, nodeID: 'b' }
    const d: HLCTimestamp = { wallTime: 1001, counter: 0, nodeID: 'a' }

    expect(HLC.compare(a, b)).toBeLessThan(0)
    expect(HLC.compare(b, c)).toBeLessThan(0)
    expect(HLC.compare(c, d)).toBeLessThan(0)
    expect(HLC.compare(a, a)).toBe(0)
  })
})
