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
 * Build a remote `SpanContext` from parsed traceparent data. Returns undefined when
 * either ID is invalid, so an unparseable or all-zero remote context can never become
 * a parent that SDKs attach real spans to.
 *
 * The single place in the package where a remote `SpanContext` is constructed.
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
