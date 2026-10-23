import { afterEach, describe, expect, test, vi } from 'vitest'

import { HLC, type HLCTimestamp } from '../src/index.js'

const COUNTER_CEILING = 1e8

function sign(n: number): number {
  return n < 0 ? -1 : n > 0 ? 1 : 0
}

function lexSign(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

describe('HLC serialized ordering', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Core guarantee behind every call site that lex-compares serialized strings:
  // lexicographic order of the serialized form must equal compare()'s numeric order
  // for every counter the clock can actually produce (0 .. COUNTER_CEILING).
  test('lexicographic order equals numeric order for all reachable counters', () => {
    const nodeIDs = ['did:key:aaa', 'did:key:bbb', 'did:key:z6Mk123', 'did:key:zzz']
    const baseWallTime = 1739539800000

    const randomTimestamp = (): HLCTimestamp => ({
      // Spread wall times across a window narrow enough to collide often (so counter
      // and nodeID tie-breaks are exercised) but wide enough to vary the ISO prefix.
      wallTime: baseWallTime + Math.floor(Math.random() * 5),
      counter: Math.floor(Math.random() * COUNTER_CEILING),
      nodeID: nodeIDs[Math.floor(Math.random() * nodeIDs.length)] ?? 'did:key:aaa',
    })

    for (let i = 0; i < 20_000; i++) {
      const a = randomTimestamp()
      const b = randomTimestamp()
      const numeric = sign(HLC.compare(a, b))
      const lexical = lexSign(HLC.serialize(a), HLC.serialize(b))
      expect(lexical).toBe(numeric)
    }
  })

  // The original 4-digit pad emitted "10000" which sorts before "9999"; with the wider
  // pad the higher counter must serialize after the lower one.
  test('counter crossing a power-of-ten boundary sorts correctly', () => {
    const lower: HLCTimestamp = { wallTime: 1739539800000, counter: 9999, nodeID: 'did:key:aaa' }
    const higher: HLCTimestamp = { wallTime: 1739539800000, counter: 10000, nodeID: 'did:key:aaa' }

    const sLower = HLC.serialize(lower)
    const sHigher = HLC.serialize(higher)

    expect(sLower < sHigher).toBe(true)
    expect(HLC.compare(lower, higher)).toBeLessThan(0)
  })

  test('serialize/parse round-trips across counter widths', () => {
    const values: Array<HLCTimestamp> = [
      { wallTime: 1739539800000, counter: 0, nodeID: 'did:key:aaa' },
      { wallTime: 1739539800000, counter: 42, nodeID: 'did:key:z6Mk123' },
      { wallTime: 1739539800000, counter: 10000, nodeID: 'did:key:aaa' },
      { wallTime: 1739539800000, counter: 99_999_999, nodeID: 'did:key:bbb' },
    ]
    for (const ts of values) {
      expect(HLC.parse(HLC.serialize(ts))).toEqual(ts)
    }
  })

  // With wall time pinned to a constant, every now() call must increment the counter
  // and produce a strictly larger serialized string. Exercises the counter accumulation
  // path under the production ceiling; the boundary itself is covered below via the
  // injectable test ceiling.
  test('counter accumulation under a pinned wall time stays strictly increasing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1739539800000)

    const clock = new HLC({ nodeID: 'did:key:local' })
    let previous = HLC.serialize(clock.now())
    for (let i = 0; i < 5000; i++) {
      const current = HLC.serialize(clock.now())
      expect(current > previous).toBe(true)
      previous = current
    }
  })

  // At the counter ceiling, the clock advances wall time by 1ms and resets the counter
  // to 0 instead of emitting a wider counter. A lowered ceiling drives the branch without
  // the ~1e8 calls the production ceiling would require. The sequence must stay strictly
  // increasing across the wrap, and the wrap must produce a wall time past the pinned
  // physical time with a reset counter.
  test('counter ceiling advances wall time and resets the counter', () => {
    vi.useFakeTimers()
    const pinned = 1739539800000
    vi.setSystemTime(pinned)

    const clock = new HLC({ nodeID: 'did:key:local', counterCeiling: 4 })
    let previous = clock.now() // { pinned, 0 }
    let wrapped: HLCTimestamp | undefined
    for (let i = 0; i < 12; i++) {
      const current = clock.now()
      expect(HLC.compare(current, previous)).toBeGreaterThan(0)
      if (current.wallTime > pinned && wrapped == null) {
        wrapped = current
      }
      previous = current
    }

    // The first wrap lands one millisecond past the pinned physical time with counter 0.
    expect(wrapped).toEqual({ wallTime: pinned + 1, counter: 0, nodeID: 'did:key:local' })
  })
})
