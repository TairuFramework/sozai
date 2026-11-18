import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'

import { checkGolden, type GoldenCase } from '../../../scripts/golden.ts'
import { HLC, type HLCTimestamp } from '../src/index.js'

const file = join(dirname(fileURLToPath(import.meta.url)), 'golden/hlc.json')
const wallTime = 1739539800000

function hlcCases(): Array<GoldenCase> {
  const timestamps: Array<HLCTimestamp> = [
    { wallTime, counter: 0, nodeID: 'did:key:aaa' },
    { wallTime, counter: 99999999, nodeID: 'did:key:aaa' },
    { wallTime, counter: 0, nodeID: 'did:key:bbb' },
    { wallTime: wallTime + 1, counter: 0, nodeID: 'did:key:aaa' },
  ]
  const cases: Array<GoldenCase> = timestamps.map((timestamp, index) => {
    const encoded = HLC.serialize(timestamp)
    return {
      name: `timestamp-${index}`,
      input: timestamp,
      expected: { encoded, parsed: HLC.parse(encoded) },
    }
  })
  for (const [aIndex, a] of timestamps.entries()) {
    for (const [bIndex, b] of timestamps.entries()) {
      const encodedA = HLC.serialize(a)
      const encodedB = HLC.serialize(b)
      const numeric = Math.sign(HLC.compare(a, b))
      const lexical = encodedA < encodedB ? -1 : encodedA > encodedB ? 1 : 0
      expect(lexical).toBe(numeric)
      cases.push({
        name: `compare-${aIndex}-${bIndex}`,
        input: { a, b },
        expected: { numeric, lexical },
      })
    }
  }
  vi.useFakeTimers()
  try {
    vi.setSystemTime(wallTime)
    const clock = new HLC({ nodeID: 'did:key:local' })
    const remote = { wallTime, counter: 99999999, nodeID: 'did:key:remote' }
    const result = clock.receive(remote)
    expect(result).toEqual({ wallTime: wallTime + 1, counter: 0, nodeID: 'did:key:local' })
    cases.push({
      name: 'counter-ceiling',
      input: { physicalTime: wallTime, nodeID: clock.nodeID, remote },
      expected: {
        timestamp: result,
        encoded: HLC.serialize(result),
        parsed: HLC.parse(HLC.serialize(result)),
      },
    })
    const next = clock.now()
    cases.push({
      name: 'after-ceiling',
      input: { physicalTime: wallTime, previous: result },
      expected: { timestamp: next, encoded: HLC.serialize(next) },
    })
  } finally {
    vi.useRealTimers()
  }
  const invalidStamps: Record<string, string> = {
    'missing-node-separator': '2026-01-01T00:00:00.000Z:12345678',
    'empty-node': '2026-01-01T00:00:00.000Z:00000001:',
    'negative-counter': '2026-01-01T00:00:00.000Z:-0000001:node',
    'signed-counter': '2026-01-01T00:00:00.000Z:+0000001:node',
    'counter-junk': '2026-01-01T00:00:00.000Z:0000001x:node',
    'counter-space': '2026-01-01T00:00:00.000Z: 0000001:node',
    'counter-newline': '2026-01-01T00:00:00.000Z:00000001\n:node',
    'short-counter': '2026-01-01T00:00:00.000Z:1:node',
    'counter-overflow': '2026-01-01T00:00:00.000Z:4294967296:node',
    'missing-time-separator': '2026-01-01T00:00:00.000Zx00000001:node',
    'missing-milliseconds': '2026-01-01T00:00:00Z:00000001:node',
    'invalid-date': '2026-02-30T00:00:00.000Z:00000001:node',
    'invalid-hour': '2026-01-01T24:00:00.000Z:00000001:node',
  }
  for (const [name, encoded] of Object.entries(invalidStamps)) {
    const parsed = HLC.tryParse(encoded)
    expect(parsed, name).toBeNull()
    cases.push({ name: `parse-${name}`, input: { encoded }, expected: { parsed } })
  }
  for (const [name, timestamp] of Object.entries({
    'colon-node': { wallTime, counter: 42, nodeID: 'did:key:node' },
    'max-counter': { wallTime, counter: 4294967295, nodeID: 'node' },
    'extended-year': { wallTime: 253402300800000, counter: 0, nodeID: 'node' },
    'negative-year': { wallTime: -62198755200000, counter: 0, nodeID: 'node' },
  })) {
    const encoded = HLC.serialize(timestamp)
    const parsed = HLC.tryParse(encoded)
    expect(parsed, name).toEqual(timestamp)
    cases.push({ name: `parse-${name}`, input: { encoded }, expected: { parsed } })
  }
  const encoded = '+002026-01-01T00:00:00.000Z:00000001:node'
  const parsed = HLC.tryParse(encoded)
  expect(parsed).toEqual({ wallTime: 1767225600000, counter: 1, nodeID: 'node' })
  cases.push({ name: 'parse-padded-positive-year', input: { encoded }, expected: { parsed } })
  return cases
}

test('golden: HLC', () => checkGolden(file, hlcCases()))
test('golden: HLC does not write without UPDATE_GOLDEN', () => {
  if (process.env.UPDATE_GOLDEN === '1') return
  const before = statSync(file).mtimeMs
  checkGolden(file, hlcCases())
  expect(statSync(file).mtimeMs).toBe(before)
})
