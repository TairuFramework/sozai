import type { SpanContext } from '@opentelemetry/api'
import { describe, expect, test } from 'vitest'

import {
  isValidSpanContext,
  isValidSpanID,
  isValidTraceID,
  toRemoteSpanContext,
} from '../src/span-context.js'

describe('isValidTraceID', () => {
  test('accepts 32 lowercase hex characters', () => {
    expect(isValidTraceID('0af7651916cd43dd8448eb211c80319c')).toBe(true)
  })

  test('rejects the all-zero trace ID', () => {
    expect(isValidTraceID('00000000000000000000000000000000')).toBe(false)
  })

  test('rejects wrong lengths', () => {
    expect(isValidTraceID('0af7651916cd43dd8448eb211c80319')).toBe(false)
    expect(isValidTraceID('0af7651916cd43dd8448eb211c80319cc')).toBe(false)
    expect(isValidTraceID('')).toBe(false)
  })

  test('rejects uppercase hex and non-hex characters', () => {
    expect(isValidTraceID('0AF7651916CD43DD8448EB211C80319C')).toBe(false)
    expect(isValidTraceID('0af7651916cd43dd8448eb211c80319z')).toBe(false)
  })
})

describe('isValidSpanID', () => {
  test('accepts 16 lowercase hex characters', () => {
    expect(isValidSpanID('00f067aa0ba902b7')).toBe(true)
  })

  test('rejects the all-zero span ID', () => {
    expect(isValidSpanID('0000000000000000')).toBe(false)
  })

  test('rejects wrong lengths', () => {
    expect(isValidSpanID('00f067aa0ba902b')).toBe(false)
    expect(isValidSpanID('00f067aa0ba902b77')).toBe(false)
    expect(isValidSpanID('')).toBe(false)
  })

  test('rejects uppercase hex and non-hex characters', () => {
    expect(isValidSpanID('00F067AA0BA902B7')).toBe(false)
    expect(isValidSpanID('00f067aa0ba902bz')).toBe(false)
  })
})

describe('isValidSpanContext', () => {
  const valid = {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: '00f067aa0ba902b7',
    traceFlags: 1,
  } as SpanContext

  test('accepts a context with both IDs valid', () => {
    expect(isValidSpanContext(valid)).toBe(true)
  })

  test('rejects an all-zero trace ID', () => {
    expect(isValidSpanContext({ ...valid, traceId: '00000000000000000000000000000000' })).toBe(
      false,
    )
  })

  test('rejects an all-zero span ID paired with a valid trace ID', () => {
    // The gap this predicate closes: the trace ID alone passed the old guards.
    expect(isValidSpanContext({ ...valid, spanId: '0000000000000000' })).toBe(false)
  })

  test('rejects a malformed span ID', () => {
    expect(isValidSpanContext({ ...valid, spanId: 'not-a-span-id' })).toBe(false)
  })
})

describe('toRemoteSpanContext', () => {
  const valid = {
    traceID: '0af7651916cd43dd8448eb211c80319c',
    spanID: '00f067aa0ba902b7',
    traceFlags: 1,
  }

  test('builds a remote SpanContext from valid data', () => {
    expect(toRemoteSpanContext(valid)).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
      isRemote: true,
    })
  })

  test('preserves unsampled flags rather than forcing SAMPLED', () => {
    expect(toRemoteSpanContext({ ...valid, traceFlags: 0 })?.traceFlags).toBe(0)
  })

  test('returns undefined for an all-zero trace ID', () => {
    expect(
      toRemoteSpanContext({ ...valid, traceID: '00000000000000000000000000000000' }),
    ).toBeUndefined()
  })

  test('returns undefined for an all-zero span ID', () => {
    expect(toRemoteSpanContext({ ...valid, spanID: '0000000000000000' })).toBeUndefined()
  })

  test('returns undefined for a malformed ID', () => {
    expect(toRemoteSpanContext({ ...valid, traceID: 'garbage' })).toBeUndefined()
  })

  test('omits traceState when not given', () => {
    expect(toRemoteSpanContext(valid)).not.toHaveProperty('traceState')
  })
})
