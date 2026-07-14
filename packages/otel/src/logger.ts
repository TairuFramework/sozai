import { context, trace } from '@opentelemetry/api'
import type { Logger } from '@sozai/log'

import { isValidTraceID } from './span-context.js'

export function traceLogger(logger: Logger): Logger {
  const span = trace.getSpan(context.active())
  if (span == null) {
    return logger
  }
  const ctx = span.spanContext()
  if (!isValidTraceID(ctx.traceId)) {
    return logger
  }
  return logger.with({ traceID: ctx.traceId, spanID: ctx.spanId })
}
