import {
  type Context,
  context,
  createTraceState,
  ROOT_CONTEXT,
  type Span,
  trace,
} from '@opentelemetry/api'

import { toRemoteSpanContext } from './span-context.js'
import { formatTraceparent, parseTraceparent } from './traceparent.js'
import { formatTracestate, parseTracestate } from './tracestate.js'

/**
 * Stamp the active span onto a request's `_meta` as W3C `traceparent` (and `tracestate`).
 * The inject-side twin of `extractW3CTraceContext`.
 *
 * Returns `meta` unchanged when there is no active span, or when the span can't produce a
 * valid header — which covers OTel's no-op spans, whose all-zero IDs would otherwise go
 * downstream as a parent.
 */
export function injectW3CTraceContext<T extends Record<string, unknown>>(
  meta: T,
): T & { traceparent?: string; tracestate?: string } {
  const span = trace.getSpan(context.active())
  if (span == null) {
    return meta
  }
  const spanContext = span.spanContext()
  const traceparent = formatTraceparent(
    spanContext.traceId,
    spanContext.spanId,
    spanContext.traceFlags,
  )
  if (traceparent == null) {
    return meta
  }
  const serializedTraceState = spanContext.traceState?.serialize()
  // Re-cap on the way out: OTel's TraceStateImpl.set() does NOT enforce the 512-char limit
  // (only _parse does), so a vendor .set() can push a capped-on-input tracestate back over
  // it. An over-length header isn't clipped downstream — the next hop's createTraceState
  // drops it entirely.
  const tracestate = serializedTraceState
    ? formatTracestate(parseTracestate(serializedTraceState))
    : undefined
  return tracestate ? { ...meta, traceparent, tracestate } : { ...meta, traceparent }
}

/**
 * Build an OTel Context from a request's W3C trace headers in `_meta`. Parses
 * `meta.traceparent` (and optional `meta.tracestate`) into a remote SpanContext.
 * Returns undefined when no valid `traceparent` is present, so callers pay
 * nothing when tracing is off. Pairs with `withActiveContext` for activation.
 */
export function extractW3CTraceContext(meta: Record<string, unknown>): Context | undefined {
  const traceparent = meta.traceparent
  if (typeof traceparent !== 'string') {
    return undefined
  }
  const parsed = parseTraceparent(traceparent)
  if (parsed == null) {
    return undefined
  }
  let traceState: ReturnType<typeof createTraceState> | undefined
  if (typeof meta.tracestate === 'string') {
    const formatted = formatTracestate(parseTracestate(meta.tracestate))
    if (formatted !== '') {
      traceState = createTraceState(formatted)
    }
  }
  const spanContext = toRemoteSpanContext(parsed, traceState)
  if (spanContext == null) {
    return undefined
  }
  return trace.setSpanContext(ROOT_CONTEXT, spanContext)
}

export function withActiveContext<T>(parentContext: Context | undefined, fn: () => T): T {
  const ctx = parentContext ?? context.active()
  return context.with(ctx, fn)
}

export function setSpanOnContext(parentContext: Context | undefined, span: Span): Context {
  const ctx = parentContext ?? context.active()
  return trace.setSpan(ctx, span)
}
