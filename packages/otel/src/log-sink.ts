import { context, trace } from '@opentelemetry/api'
import { type LogAttributes, logs, SeverityNumber } from '@opentelemetry/api-logs'
import type { LogLevel, LogRecord } from '@sozai/log'
import { renderLogMessage } from '@sozai/log'

const LEVEL_TO_SEVERITY: Record<LogLevel, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warning: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
}

export function createOTelLogSink(): (record: LogRecord) => void {
  const logger = logs.getLogger('sozai')

  return (record: LogRecord) => {
    const activeSpan = trace.getSpan(context.active())

    const attributes: LogAttributes = {
      ...(record.properties as LogAttributes),
      'log.category': record.category.join('.'),
    }

    logger.emit({
      severityNumber: LEVEL_TO_SEVERITY[record.level],
      severityText: record.level,
      body: renderLogMessage(record),
      attributes,
      timestamp: record.timestamp,
      context: activeSpan ? context.active() : undefined,
    })
  }
}
