import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api'
import { describe, expect, test, vi } from 'vitest'

import {
  createTracerFactory,
  getActiveBaggage,
  getActiveSpan,
  getActiveTraceContext,
  withActiveBaggage,
  withSpan,
  withSyncSpan,
} from '../src/tracers.js'

const createTracer = createTracerFactory('test')

describe('createTracerFactory', () => {
  test('returns a factory that produces a Tracer from the global TracerProvider', () => {
    const tracer = createTracerFactory('sozai')('test-module')
    expect(tracer).toBeDefined()
    // Without an SDK registered, this returns a no-op tracer
    expect(typeof tracer.startSpan).toBe('function')
    expect(typeof tracer.startActiveSpan).toBe('function')
  })
})

describe('getActiveTraceContext', () => {
  test('returns undefined when no span is active', () => {
    expect(getActiveTraceContext()).toBeUndefined()
  })

  test('returns undefined for a malformed but non-zero trace ID', () => {
    // isValidTraceID rejects malformed-but-nonzero IDs, not just the all-zero
    // no-op case. A real SDK never produces one, so this is only reachable via
    // a fake span, but it pins the widened guard's behavior.
    const fakeSpan = {
      spanContext: () => ({
        traceId: 'not-a-valid-trace-id',
        spanId: '0000000000000001',
        traceFlags: 1,
      }),
    } as unknown as Span
    context.with(trace.setSpan(context.active(), fakeSpan), () => {
      expect(getActiveTraceContext()).toBeUndefined()
    })
  })
})

describe('withSpan', () => {
  test('executes the function and returns its result', async () => {
    const tracer = createTracer('test')
    const result = await withSpan(tracer, 'test-span', {}, async () => {
      return 42
    })
    expect(result).toBe(42)
  })

  test('propagates errors from the function', async () => {
    const tracer = createTracer('test')
    await expect(
      withSpan(tracer, 'test-span', {}, async () => {
        throw new Error('test error')
      }),
    ).rejects.toThrow('test error')
  })

  test('passes the span to the function', async () => {
    const tracer = createTracer('test')
    await withSpan(tracer, 'test-span', {}, async (span) => {
      expect(span).toBeDefined()
      expect(typeof span.setAttribute).toBe('function')
      expect(typeof span.setStatus).toBe('function')
      expect(typeof span.end).toBe('function')
    })
  })
})

describe('getActiveSpan', () => {
  test('returns undefined when no span is active', () => {
    expect(getActiveSpan()).toBeUndefined()
  })
})

describe('getActiveBaggage', () => {
  test('returns undefined when no baggage is active', () => {
    // No ContextManager is registered in tests, so the active context is ROOT
    // (empty). This is also the real-world "no SDK / no baggage" case.
    expect(getActiveBaggage()).toBeUndefined()
  })
})

describe('withSyncSpan', () => {
  test('executes the function and returns its result', () => {
    const tracer = createTracer('test')
    const result = withSyncSpan(tracer, 'test-span', {}, () => 42)
    expect(result).toBe(42)
  })

  test('propagates errors from the function', () => {
    const tracer = createTracer('test')
    expect(() =>
      withSyncSpan(tracer, 'test-span', {}, () => {
        throw new Error('test error')
      }),
    ).toThrow('test error')
  })

  test('passes the span to the function', () => {
    const tracer = createTracer('test')
    withSyncSpan(tracer, 'test-span', {}, (span) => {
      expect(span).toBeDefined()
      expect(typeof span.setAttribute).toBe('function')
    })
  })
})

describe('withActiveBaggage', () => {
  // No ContextManager is registered in tests, so context.active() inside fn is
  // still ROOT; we assert the wrapper returns fn's result (matching withSpan).
  // Activation correctness is covered by the entriesToBaggage round-trip tests.
  test('executes the function and returns its result', () => {
    const result = withActiveBaggage([{ key: 'userId', value: 'alice' }], () => 42)
    expect(result).toBe(42)
  })

  test('accepts empty entries', () => {
    expect(withActiveBaggage([], () => 'ok')).toBe('ok')
  })
})

describe('createTracerFactory version', () => {
  test('accepts a caller-supplied version', () => {
    const tracer = createTracerFactory('enkaku', '1.2.3')('client')
    expect(tracer).toBeDefined()
    expect(typeof tracer.startSpan).toBe('function')
  })

  test('works without a version', () => {
    const tracer = createTracerFactory('enkaku')('client')
    expect(tracer).toBeDefined()
    expect(typeof tracer.startSpan).toBe('function')
  })

  test('forwards the version through to trace.getTracer', () => {
    const spy = vi.spyOn(trace, 'getTracer')
    try {
      createTracerFactory('enkaku', '1.2.3')('client')
      expect(spy).toHaveBeenCalledWith('enkaku.client', '1.2.3')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('span status', () => {
  test('leaves status UNSET on success rather than setting OK', () => {
    // OTel reserves Ok for an explicit application override; instrumentation
    // leaves the status Unset, which backends read as success.
    const tracer = createTracer('test')
    const statuses: Array<unknown> = []
    withSyncSpan(tracer, 'test', {}, (span) => {
      const original = span.setStatus.bind(span)
      span.setStatus = (status) => {
        statuses.push(status)
        return original(status)
      }
      return 'ok'
    })
    expect(statuses).toEqual([])
  })

  test('still sets ERROR status when the callback throws', () => {
    const tracer = createTracer('test')
    const statuses: Array<{ code: number }> = []
    expect(() =>
      withSyncSpan(tracer, 'test', {}, (span) => {
        const original = span.setStatus.bind(span)
        span.setStatus = (status) => {
          statuses.push(status as { code: number })
          return original(status)
        }
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(statuses).toHaveLength(1)
    expect(statuses[0].code).toBe(SpanStatusCode.ERROR)
  })

  test('withSpan leaves status UNSET on success rather than setting OK', async () => {
    const tracer = createTracer('test')
    const statuses: Array<unknown> = []
    const result = await withSpan(tracer, 'test', {}, async (span) => {
      const original = span.setStatus.bind(span)
      span.setStatus = (status) => {
        statuses.push(status)
        return original(status)
      }
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(statuses).toEqual([])
  })

  test('withSpan still sets ERROR status when the callback rejects', async () => {
    const tracer = createTracer('test')
    const statuses: Array<{ code: number }> = []
    await expect(
      withSpan(tracer, 'test', {}, async (span) => {
        const original = span.setStatus.bind(span)
        span.setStatus = (status) => {
          statuses.push(status as { code: number })
          return original(status)
        }
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(statuses).toHaveLength(1)
    expect(statuses[0].code).toBe(SpanStatusCode.ERROR)
  })
})
