import { describe, expect, test } from 'vitest'

import { HLC } from '../src/index.js'

describe('HLC beforeMint hook', () => {
  test('a throwing hook vetoes now() but leaves receive() working', () => {
    const clock = new HLC({
      nodeID: 'did:key:gated',
      beforeMint() {
        throw new Error('gated')
      },
    })

    expect(() => clock.now()).toThrow('gated')
    // receive() advances the clock on peer input without minting locally, so
    // the veto must not reach it.
    const received = clock.receive({ wallTime: Date.now(), counter: 5, nodeID: 'did:key:peer' })
    expect(received.wallTime).toBeGreaterThan(0)
  })

  test('the hook runs before minting, so a veto emits no timestamp', () => {
    let calls = 0
    const clock = new HLC({
      nodeID: 'did:key:gated',
      beforeMint() {
        calls += 1
        throw new Error('gated')
      },
    })
    expect(() => clock.now()).toThrow('gated')
    expect(calls).toBe(1)
  })

  test('a passing hook runs each mint and does not alter the timestamp', () => {
    let calls = 0
    const clock = new HLC({
      nodeID: 'did:key:ok',
      beforeMint() {
        calls += 1
      },
    })
    const ts1 = clock.now()
    const ts2 = clock.now()
    expect(calls).toBe(2)
    expect(ts1.nodeID).toBe('did:key:ok')
    expect(HLC.compare(ts2, ts1)).toBeGreaterThan(0)
  })

  test('no hook mints freely', () => {
    const clock = new HLC({ nodeID: 'did:key:free' })
    expect(() => clock.now()).not.toThrow()
  })
})
