import { AsyncLocalStorage } from 'node:async_hooks'

import { type Context, context, ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { describe, expect, test } from 'vitest'

import {
  extractW3CTraceContext,
  injectW3CTraceContext,
  setSpanOnContext,
  withActiveContext,
} from '../src/context.js'
import { createTracerFactory } from '../src/tracers.js'

const createTracer = createTracerFactory('test')

// `@opentelemetry/api`'s default NoopContextManager makes `context.with()` a
// pass-through and `context.active()` always return ROOT_CONTEXT — without a
// ContextManager registered, activation never actually propagates. No package
// in this repo registers one (that's a real SDK's job at startup), so the
// round-trip and tracestate tests below need a minimal one to make
// `withActiveContext` observably "activate" its argument. This uses Node's
// core `async_hooks` directly rather than pulling in an OTel SDK package or
// tracer/exporter — it is scoped to this test file only.
class TestContextManager {
  #storage = new AsyncLocalStorage<Context>()

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT
  }

  with<A extends Array<unknown>, F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(ctx, () => fn.apply(thisArg, args))
  }

  bind<T>(_ctx: Context, target: T): T {
    return target
  }

  enable(): this {
    return this
  }

  disable(): this {
    return this
  }
}

context.setGlobalContextManager(new TestContextManager())

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
    expect(result).toEqual(meta)
    expect(result).not.toHaveProperty('traceparent')
  })

  test('returns meta unchanged for a no-op span with all-zero IDs', () => {
    // Without an SDK registered, startSpan produces a no-op span. Stamping its
    // all-zero IDs would hand a downstream service an invalid parent.
    const tracer = createTracer('test')
    const span = tracer.startSpan('test')
    const meta = withActiveContext(setSpanOnContext(undefined, span), () =>
      injectW3CTraceContext({ procedure: 'test' }),
    )
    span.end()
    expect(meta).not.toHaveProperty('traceparent')
  })

  test('preserves existing meta properties', () => {
    const result = injectW3CTraceContext({ procedure: 'test', requestID: 'abc' })
    expect(result.procedure).toBe('test')
    expect(result.requestID).toBe('abc')
  })

  test('round-trips through extractW3CTraceContext', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01'
    const parentContext = extractW3CTraceContext({ traceparent })
    const meta = withActiveContext(parentContext, () =>
      injectW3CTraceContext<Record<string, unknown>>({}),
    )
    expect(meta.traceparent).toBe(traceparent)
  })

  test('stamps tracestate when the active span carries one', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01'
    const parentContext = extractW3CTraceContext({ traceparent, tracestate: 'vendor=value' })
    const meta = withActiveContext(parentContext, () =>
      injectW3CTraceContext<Record<string, unknown>>({}),
    )
    expect(meta.tracestate).toBe('vendor=value')
  })

  test('omits tracestate when the active span has none', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01'
    const parentContext = extractW3CTraceContext({ traceparent })
    const meta = withActiveContext(parentContext, () => injectW3CTraceContext({}))
    expect(meta).not.toHaveProperty('tracestate')
  })
})
