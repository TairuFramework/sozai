import { describe, expect, test } from 'vitest'

import { formatTraceparent, parseTraceparent } from '../src/traceparent.js'

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const SPAN_ID = '00f067aa0ba902b7'

describe('formatTraceparent', () => {
  test('formats a traceparent header', () => {
    expect(formatTraceparent(TRACE_ID, SPAN_ID, 1)).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`)
  })

  test('formats with zero flags', () => {
    expect(formatTraceparent(TRACE_ID, SPAN_ID, 0)).toBe(`00-${TRACE_ID}-${SPAN_ID}-00`)
  })

  test('returns undefined for an all-zero trace ID', () => {
    expect(formatTraceparent('0'.repeat(32), SPAN_ID, 1)).toBeUndefined()
  })

  test('returns undefined for an all-zero span ID', () => {
    expect(formatTraceparent(TRACE_ID, '0'.repeat(16), 1)).toBeUndefined()
  })

  test('returns undefined for malformed IDs', () => {
    expect(formatTraceparent('short', SPAN_ID, 1)).toBeUndefined()
    expect(formatTraceparent(TRACE_ID, `${SPAN_ID}extra`, 1)).toBeUndefined()
    expect(formatTraceparent(TRACE_ID.toUpperCase(), SPAN_ID, 1)).toBeUndefined()
  })

  test('returns undefined for out-of-range flags rather than masking them', () => {
    // 256 & 0xff === 0, which would silently turn a sampled trace unsampled.
    expect(formatTraceparent(TRACE_ID, SPAN_ID, 256)).toBeUndefined()
    expect(formatTraceparent(TRACE_ID, SPAN_ID, -1)).toBeUndefined()
    expect(formatTraceparent(TRACE_ID, SPAN_ID, 1.5)).toBeUndefined()
    expect(formatTraceparent(TRACE_ID, SPAN_ID, Number.NaN)).toBeUndefined()
  })

  test('formats the maximum in-range flags', () => {
    expect(formatTraceparent(TRACE_ID, SPAN_ID, 255)).toBe(`00-${TRACE_ID}-${SPAN_ID}-ff`)
  })
})

describe('parseTraceparent', () => {
  test('parses a valid traceparent header', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`)).toEqual({
      traceID: TRACE_ID,
      spanID: SPAN_ID,
      traceFlags: 1,
    })
  })

  test('returns undefined for invalid format', () => {
    expect(parseTraceparent('invalid')).toBeUndefined()
    expect(parseTraceparent('')).toBeUndefined()
    expect(parseTraceparent(`00-short-${SPAN_ID}-01`)).toBeUndefined()
  })

  test('returns undefined for version ff, which the spec declares invalid', () => {
    expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeUndefined()
  })

  test('returns undefined for an all-zero trace ID', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN_ID}-01`)).toBeUndefined()
  })

  test('returns undefined for an all-zero span ID', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${'0'.repeat(16)}-01`)).toBeUndefined()
  })

  test('parses the first four fields of a future version', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-extra-fields`)).toEqual({
      traceID: TRACE_ID,
      spanID: SPAN_ID,
      traceFlags: 1,
    })
  })

  test('parses a future version with no trailing fields', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01`)).toEqual({
      traceID: TRACE_ID,
      spanID: SPAN_ID,
      traceFlags: 1,
    })
  })

  test('rejects a trailing field on version 00, which is malformed rather than future', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01-extra`)).toBeUndefined()
  })

  test('rejects a trailing dash with no content', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-`)).toBeUndefined()
  })

  test('preserves unknown future flag bits without interpreting them', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-ff`)?.traceFlags).toBe(255)
  })
})
