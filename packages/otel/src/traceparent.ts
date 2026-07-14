import { isValidSpanID, isValidTraceID } from './span-context.js'

export type TraceparentData = {
  traceID: string
  spanID: string
  traceFlags: number
}

// Four required fields, plus an optional trailing segment that only a future
// version may carry. The trailing segment must be non-empty, so a bare trailing
// dash stays malformed.
const TRACEPARENT_REGEX = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})(-.+)?$/

const MAX_TRACE_FLAGS = 0xff

/**
 * Format a W3C traceparent header value. Returns undefined when the IDs or flags
 * cannot produce a valid header, rather than emitting a malformed one — an omitted
 * header is the correct wire outcome, since no trace beats a corrupt trace.
 *
 * Out-of-range flags are rejected, not masked: `256 & 0xff` is `0`, which would
 * silently flip a sampled trace to unsampled.
 */
export function formatTraceparent(
  traceID: string,
  spanID: string,
  traceFlags: number,
): string | undefined {
  if (!isValidTraceID(traceID) || !isValidSpanID(spanID)) {
    return undefined
  }
  if (!Number.isInteger(traceFlags) || traceFlags < 0 || traceFlags > MAX_TRACE_FLAGS) {
    return undefined
  }
  return `00-${traceID}-${spanID}-${traceFlags.toString(16).padStart(2, '0')}`
}

/**
 * Parse a W3C traceparent header value. Returns undefined if invalid.
 *
 * Version handling follows the spec: `ff` is invalid outright; version `00` must carry
 * exactly four fields; a higher version has its first four fields parsed and any
 * trailing content ignored, so a future sender still propagates through us.
 *
 * Unknown flag bits from a future version are preserved on `traceFlags` but never
 * interpreted — only bit 0 (sampled) is ever read.
 */
export function parseTraceparent(header: string): TraceparentData | undefined {
  const match = TRACEPARENT_REGEX.exec(header)
  if (match == null) {
    return undefined
  }
  const [, version, traceID, spanID, flags, trailing] = match
  if (version === 'ff') {
    return undefined
  }
  if (version === '00' && trailing != null) {
    return undefined
  }
  if (!isValidTraceID(traceID) || !isValidSpanID(spanID)) {
    return undefined
  }
  return {
    traceID,
    spanID,
    traceFlags: Number.parseInt(flags, 16),
  }
}
