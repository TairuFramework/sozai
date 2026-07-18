import type { SpanContext, TraceState } from '@opentelemetry/api'

import { ZERO_SPAN_ID, ZERO_TRACE_ID } from './semantic.js'
import type { TraceparentData } from './traceparent.js'

const TRACE_ID_REGEX = /^[\da-f]{32}$/
const SPAN_ID_REGEX = /^[\da-f]{16}$/

/**
 * Whether `value` is a valid W3C trace ID: 32 lowercase hex characters, not all-zero.
 */
export function isValidTraceID(value: string): boolean {
  return TRACE_ID_REGEX.test(value) && value !== ZERO_TRACE_ID
}

/**
 * Whether `value` is a valid W3C span ID: 16 lowercase hex characters, not all-zero.
 */
export function isValidSpanID(value: string): boolean {
  return SPAN_ID_REGEX.test(value) && value !== ZERO_SPAN_ID
}

/**
 * Whether `ctx` is a real span context: both IDs well-formed and non-zero.
 *
 * The trace ID alone is not enough. OTel's no-op spans zero both IDs, so a trace-ID-only
 * check catches them — but a hand-constructed or malformed context can pair a valid trace
 * ID with an all-zero span ID, and that must not be stamped onto logs or handed out as a
 * trace context.
 */
export function isValidSpanContext(ctx: SpanContext): boolean {
  return isValidTraceID(ctx.traceId) && isValidSpanID(ctx.spanId)
}

/**
 * Build a remote `SpanContext` from parsed traceparent data. Undefined when either ID is
 * invalid, so an all-zero or garbage remote context can't become a parent that SDKs attach
 * real spans to.
 *
 * The only place in the package that constructs a remote `SpanContext` — keep it that way.
 */
export function toRemoteSpanContext(
  data: TraceparentData,
  traceState?: TraceState,
): SpanContext | undefined {
  if (!isValidTraceID(data.traceID) || !isValidSpanID(data.spanID)) {
    return undefined
  }
  const spanContext: SpanContext = {
    traceId: data.traceID,
    spanId: data.spanID,
    traceFlags: data.traceFlags,
    isRemote: true,
  }
  if (traceState != null) {
    spanContext.traceState = traceState
  }
  return spanContext
}
