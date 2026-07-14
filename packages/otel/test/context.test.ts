import { context, createTraceState, ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { describe, expect, test } from 'vitest'

import {
  extractW3CTraceContext,
  injectW3CTraceContext,
  setSpanOnContext,
  withActiveContext,
} from '../src/context.js'
import { createTracerFactory } from '../src/tracers.js'
import { useTestContextManager } from './helpers/context-manager.js'

const createTracer = createTracerFactory('test')

// Without a registered ContextManager, `NoopContextManager` (the
// `@opentelemetry/api` default) discards whatever is passed to
// `context.with()` and `context.active()` always returns `ROOT_CONTEXT` — the
// context-activation tests below would then pass vacuously. See
// `test/helpers/context-manager.ts` for details.
useTestContextManager()

describe('withActiveContext', () => {
  test('executes function and returns its result', () => {
    const result = withActiveContext(undefined, () => 42)
    expect(result).toBe(42)
  })
})

describe('setSpanOnContext', () => {
  test('returns a Context object', () => {
    const tracer = createTracer('test')
    const span = tracer.startSpan('test')
    const ctx = setSpanOnContext(undefined, span)
    expect(ctx).toBeDefined()
    span.end()
  })
})

describe('extractW3CTraceContext', () => {
  const traceparent = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01'

  test('returns undefined when traceparent is absent', () => {
    expect(extractW3CTraceContext({})).toBeUndefined()
  })

  test('returns undefined when traceparent is not a string', () => {
    expect(extractW3CTraceContext({ traceparent: 123 })).toBeUndefined()
  })

  test('returns undefined for a malformed traceparent', () => {
    expect(extractW3CTraceContext({ traceparent: 'garbage' })).toBeUndefined()
  })

  test('builds a remote SpanContext from a valid traceparent', () => {
    const ctx = extractW3CTraceContext({ traceparent })
    expect(ctx).toBeDefined()
    const span = trace.getSpan(ctx as NonNullable<typeof ctx>)
    const spanCtx = (span as NonNullable<typeof span>).spanContext()
    expect(spanCtx.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
    expect(spanCtx.spanId).toBe('00f067aa0ba902b7')
    expect(spanCtx.traceFlags).toBe(1)
    expect(spanCtx.isRemote).toBe(true)
  })

  test('uses the parsed trace flags rather than a hardcoded value', () => {
    const ctx = extractW3CTraceContext({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-00',
    })
    const span = trace.getSpan(ctx as NonNullable<typeof ctx>)
    expect((span as NonNullable<typeof span>).spanContext().traceFlags).toBe(0)
  })

  test('attaches tracestate when present', () => {
    const ctx = extractW3CTraceContext({ traceparent, tracestate: 'vendor=value' })
    const span = trace.getSpan(ctx as NonNullable<typeof ctx>)
    expect((span as NonNullable<typeof span>).spanContext().traceState?.get('vendor')).toBe('value')
  })

  test('returns undefined for an all-zero trace ID', () => {
    expect(
      extractW3CTraceContext({
        traceparent: `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`,
      }),
    ).toBeUndefined()
  })

  test('returns undefined for an all-zero span ID', () => {
    expect(
      extractW3CTraceContext({
        traceparent: `00-0af7651916cd43dd8448eb211c80319c-${'0'.repeat(16)}-01`,
      }),
    ).toBeUndefined()
  })
})

describe('injectW3CTraceContext', () => {
  test('returns meta unchanged when no span is active', () => {
    const meta = { procedure: 'test' }
    const result = injectW3CTraceContext(meta)
    expect(result).toBe(meta)
    expect(result).not.toHaveProperty('traceparent')
  })

  test('returns meta unchanged for a no-op span with all-zero IDs', () => {
    // Without an SDK registered, startSpan produces a no-op span. Stamping its
    // all-zero IDs would hand a downstream service an invalid parent.
    const tracer = createTracer('test')
    const span = tracer.startSpan('test')
    const meta = withActiveContext(setSpanOnContext(undefined, span), () => {
      // Precondition: the span really is active. Without this, a regression
      // in ContextManager registration would make this test pass for the
      // wrong reason again — "skipped because no span was active" rather than
      // "skipped because the IDs were invalid".
      expect(trace.getSpan(context.active())).toBeDefined()
      return injectW3CTraceContext({ procedure: 'test' })
    })
    span.end()
    expect(meta).not.toHaveProperty('traceparent')
  })

  test('preserves existing meta properties', () => {
    const result = injectW3CTraceContext({ procedure: 'test', requestID: 'abc' })
    expect(result.procedure).toBe('test')
    expect(result.requestID).toBe('abc')
  })

  test('round-trips through extractW3CTraceContext, preserving existing keys', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01'
    const parentContext = extractW3CTraceContext({ traceparent })
    const meta = withActiveContext(parentContext, () =>
      injectW3CTraceContext({ procedure: 'test' }),
    )
    expect(meta.traceparent).toBe(traceparent)
    expect(meta.procedure).toBe('test')
  })

  test('stamps tracestate when the active span carries one', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01'
    const parentContext = extractW3CTraceContext({ traceparent, tracestate: 'vendor=value' })
    const meta = withActiveContext(parentContext, () => injectW3CTraceContext({}))
    expect(meta.tracestate).toBe('vendor=value')
  })

  test('omits tracestate when the active span has none', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01'
    const parentContext = extractW3CTraceContext({ traceparent })
    const meta = withActiveContext(parentContext, () => injectW3CTraceContext({}))
    expect(meta).not.toHaveProperty('tracestate')
  })

  test('caps an over-512-character tracestate on inject, and the emitted header survives createTraceState round-trip non-empty', () => {
    // TraceStateImpl.set() does NOT enforce the 512-char cap (only _parse()
    // does), so a TraceState built via chained .set() calls can exceed 512
    // characters on serialize() even though it never went through a header
    // string long enough to trip _parse's own bail-out. This is exactly the
    // shape that reaches injectW3CTraceContext in practice: an inbound span
    // whose tracestate a vendor then extends with .set().
    let state = createTraceState()
    for (let i = 0; i < 40; i++) {
      state = state.set(`vendor${i}`, 'x'.repeat(20))
    }
    // Precondition: confirm the fixture actually exceeds the cap, so this
    // test cannot pass merely because the built state was already short.
    expect(state.serialize().length).toBeGreaterThan(512)

    const spanContext = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
      traceState: state,
    }
    const ctx = trace.setSpanContext(ROOT_CONTEXT, spanContext)

    const meta = withActiveContext(ctx, () => injectW3CTraceContext({}))

    expect(meta.tracestate).toBeDefined()
    const tracestate = meta.tracestate as string
    expect(tracestate.length).toBeLessThanOrEqual(512)
    // The real proof: the emitted header must not just be short — it must
    // survive the next hop's createTraceState(...).serialize() non-empty.
    // OTel's TraceStateImpl._parse bails out and yields an empty trace state
    // for any header over 512 chars, so a length assertion alone would not
    // catch a cap that's off by even one character.
    expect(createTraceState(tracestate).serialize()).not.toBe('')
    expect(createTraceState(tracestate).serialize().length).toBeLessThanOrEqual(512)
  })
})
