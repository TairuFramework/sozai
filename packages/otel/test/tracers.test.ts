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
import { useTestContextManager } from './helpers/context-manager.js'

// A real ContextManager is required so `context.with()` genuinely activates
// its argument — see `test/helpers/context-manager.ts`. Without it, spans
// and baggage set via `context.with()` are silently discarded and several
// guards below (e.g. `getActiveTraceContext`'s `isValidTraceID` check) would
// never actually run.
useTestContextManager()

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
    // a fake span. A real ContextManager is registered (see the top of this
    // file), so the fake span genuinely becomes the active span here — this
    // exercises `isValidTraceID` itself, not the `span == null` early return.
    const fakeSpan = {
      spanContext: () => ({
        traceId: 'not-a-valid-trace-id',
        spanId: '0000000000000001',
        traceFlags: 1,
      }),
    } as unknown as Span
    context.with(trace.setSpan(context.active(), fakeSpan), () => {
      // Precondition: the fake span really is active, so a failure below can
      // only come from the `isValidTraceID` guard, not from `span == null`.
      expect(trace.getSpan(context.active())).toBe(fakeSpan)
      expect(getActiveTraceContext()).toBeUndefined()
    })
  })

  test('returns undefined for a valid trace ID paired with an all-zero span ID', () => {
    // The trace-ID-only guard would let this through and return
    // spanID: '0000000000000000' as if it were a real trace context. A real
    // ContextManager is registered (see the top of this file), so the fake span
    // genuinely becomes active here.
    const fakeSpan = {
      spanContext: () => ({
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: '0000000000000000',
        traceFlags: 1,
      }),
    } as unknown as Span
    context.with(trace.setSpan(context.active(), fakeSpan), () => {
      // Precondition: the fake span really is active, so a failure below can
      // only come from the span-context guard, not from `span == null`.
      expect(trace.getSpan(context.active())).toBe(fakeSpan)
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
    // A real ContextManager is registered (see the top of this file), but
    // this test never enters a `context.with()` that sets baggage, so the
    // active context here is still ROOT (empty) — the real-world
    // "no SDK / no baggage" case too.
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
  test('executes the function and returns its result', () => {
    const result = withActiveBaggage([{ key: 'userId', value: 'alice' }], () => 42)
    expect(result).toBe(42)
  })

  test('accepts empty entries', () => {
    expect(withActiveBaggage([], () => 'ok')).toBe('ok')
  })

  test('actually activates the given baggage for the duration of fn', () => {
    // With a real ContextManager registered (see the top of this file),
    // `getActiveBaggage()` inside `fn` must observe the entries passed in —
    // this is the activation behavior the two tests above don't exercise.
    const observed = withActiveBaggage([{ key: 'userId', value: 'alice' }], () =>
      getActiveBaggage(),
    )
    expect(observed).toEqual([{ key: 'userId', value: 'alice' }])
    // Outside fn, activation must not leak.
    expect(getActiveBaggage()).toBeUndefined()
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
