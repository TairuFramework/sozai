// Re-export commonly used OTel types so consuming packages don't need @opentelemetry/api directly
export {
  type Context,
  type Meter,
  type MeterOptions,
  type Span,
  type SpanOptions,
  SpanStatusCode,
  TraceFlags,
  type Tracer,
  type TracerOptions,
} from '@opentelemetry/api'

export {
  type BaggageEntry,
  type BaggageProperty,
  baggageToEntries,
  entriesToBaggage,
  formatBaggage,
  parseBaggage,
} from './baggage.js'
export {
  extractW3CTraceContext,
  injectW3CTraceContext,
  setSpanOnContext,
  withActiveContext,
} from './context.js'
export { createOTelLogSink } from './log-sink.js'
export { traceLogger } from './logger.js'
export { createMeterFactory } from './meters.js'
export { AttributeKeys, ZERO_TRACE_ID } from './semantic.js'
export { isValidSpanID, isValidTraceID } from './span-context.js'
export { formatTraceparent, parseTraceparent, type TraceparentData } from './traceparent.js'
export {
  createTracerFactory,
  getActiveBaggage,
  getActiveSpan,
  getActiveTraceContext,
  type TraceContext,
  withActiveBaggage,
  withSpan,
  withSyncSpan,
} from './tracers.js'
export { formatTracestate, parseTracestate, type TracestateEntry } from './tracestate.js'
