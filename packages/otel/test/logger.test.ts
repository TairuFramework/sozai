import { context, type Span, trace } from '@opentelemetry/api'
import type { Logger } from '@sozai/log'
import { describe, expect, test } from 'vitest'

import { traceLogger } from '../src/logger.js'
import { useTestContextManager } from './helpers/context-manager.js'

// A real ContextManager is required so a span set via `context.with()`
// genuinely becomes active — see `test/helpers/context-manager.ts`.
useTestContextManager()

describe('traceLogger', () => {
  test('returns the same logger when no span is active', () => {
    const mockLogger = { with: () => mockLogger } as unknown as Logger
    const result = traceLogger(mockLogger)
    expect(result).toBe(mockLogger)
  })

  test('attaches traceID/spanID when a span with a valid trace ID is active', () => {
    let captured: Record<string, unknown> | undefined
    const mockLogger = {
      with: (properties: Record<string, unknown>) => {
        captured = properties
        return mockLogger
      },
    } as unknown as Logger

    const fakeSpan = {
      spanContext: () => ({
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: '00f067aa0ba902b7',
        traceFlags: 1,
      }),
    } as unknown as Span

    const result = context.with(trace.setSpan(context.active(), fakeSpan), () =>
      traceLogger(mockLogger),
    )

    expect(result).toBe(mockLogger)
    expect(captured).toEqual({
      traceID: '0af7651916cd43dd8448eb211c80319c',
      spanID: '00f067aa0ba902b7',
    })
  })

  test('returns the same logger for a no-op span with an all-zero trace ID', () => {
    const mockLogger = { with: () => mockLogger } as unknown as Logger
    const fakeSpan = {
      spanContext: () => ({
        traceId: '00000000000000000000000000000000',
        spanId: '0000000000000000',
        traceFlags: 0,
      }),
    } as unknown as Span

    const result = context.with(trace.setSpan(context.active(), fakeSpan), () =>
      traceLogger(mockLogger),
    )

    expect(result).toBe(mockLogger)
  })

  test('returns the same logger for a malformed but non-zero trace ID', () => {
    // Exercises isValidTraceID's regex rejection, not just the all-zero case.
    const mockLogger = { with: () => mockLogger } as unknown as Logger
    const fakeSpan = {
      spanContext: () => ({
        traceId: 'not-a-valid-trace-id',
        spanId: '00f067aa0ba902b7',
        traceFlags: 1,
      }),
    } as unknown as Span

    const result = context.with(trace.setSpan(context.active(), fakeSpan), () =>
      traceLogger(mockLogger),
    )

    expect(result).toBe(mockLogger)
  })
})
