import type { Context, SpanOptions, Tracer } from '@opentelemetry/api'
import { context, propagation, type Span, SpanStatusCode, trace } from '@opentelemetry/api'

import { type BaggageEntry, baggageToEntries, entriesToBaggage } from './baggage.js'
import { isValidSpanContext } from './span-context.js'

/**
 * Build a tracer factory for a consuming package.
 *
 * `version` is the *consumer's* version, not this package's: the instrumentation-scope
 * version means the version of the instrumentation library, and `prefix.name` identifies
 * the consumer. Optional — `undefined` is a legal scope version.
 */
export function createTracerFactory(prefix: string, version?: string): (name: string) => Tracer {
  return (name: string): Tracer => trace.getTracer(`${prefix}.${name}`, version)
}

export type TraceContext = {
  traceID: string
  spanID: string
  traceFlags: number
}

export function getActiveSpan(): Span | undefined {
  return trace.getSpan(context.active()) ?? undefined
}

export function getActiveTraceContext(): TraceContext | undefined {
  const span = trace.getSpan(context.active())
  if (span == null) {
    return undefined
  }
  const ctx = span.spanContext()
  // No-op spans carry all-zero IDs; they are not a real trace context. Both IDs are
  // checked — a valid trace ID paired with an all-zero span ID is not one either.
  if (!isValidSpanContext(ctx)) {
    return undefined
  }
  return {
    traceID: ctx.traceId,
    spanID: ctx.spanId,
    traceFlags: ctx.traceFlags,
  }
}

export function getActiveBaggage(): Array<BaggageEntry> | undefined {
  const baggage = propagation.getActiveBaggage()
  if (baggage == null) {
    return undefined
  }
  const entries = baggageToEntries(baggage)
  return entries.length === 0 ? undefined : entries
}

export function withSyncSpan<T>(
  tracer: Tracer,
  name: string,
  options: SpanOptions,
  fn: (span: Span) => T,
  parentContext?: Context,
): T {
  const ctx = parentContext ?? context.active()
  const span = tracer.startSpan(name, options, ctx)
  const spanCtx = trace.setSpan(ctx, span)
  try {
    return context.with(spanCtx, () => fn(span))
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    })
    span.recordException(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    span.end()
  }
}

export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
  parentContext?: Context,
): Promise<T> {
  const ctx = parentContext ?? context.active()
  return tracer.startActiveSpan(name, options, ctx, async (span) => {
    try {
      return await fn(span)
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      })
      span.recordException(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      span.end()
    }
  })
}

/**
 * Activate the given baggage entries for the duration of `fn`, so a handler's
 * `getActiveBaggage()` reflects the client's baggage. Symmetric with the
 * read-only `getActiveBaggage`.
 */
export function withActiveBaggage<T>(entries: Array<BaggageEntry>, fn: () => T): T {
  const baggage = entriesToBaggage(entries)
  return context.with(propagation.setBaggage(context.active(), baggage), fn)
}
