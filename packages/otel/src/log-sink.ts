import { context, trace } from '@opentelemetry/api'
import { type LogAttributes, logs, SeverityNumber } from '@opentelemetry/api-logs'
import type { LogLevel, LogRecord } from '@sozai/log'

const LEVEL_TO_SEVERITY: Record<LogLevel, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warning: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
}

// Render one segment of `record.message` for a tagged-template log body. Literal
// segments (even indices) and already-string values pass through as-is. Other
// interpolated values are JSON-rendered — but JSON.stringify throws on a BigInt
// or a circular structure, and logtape catches sink exceptions, meta-logs them,
// and silently drops the record. This must never throw: fall back to `String(part)`
// (e.g. `[object Object]` for a circular value, `'10'` for `10n`) rather than lose
// the record.
function renderMessagePart(part: unknown, index: number): string {
  if (index % 2 === 0 || typeof part === 'string') {
    return String(part)
  }
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

export function createOTelLogSink(): (record: LogRecord) => void {
  const logger = logs.getLogger('sozai')

  return (record: LogRecord) => {
    const activeSpan = trace.getSpan(context.active())

    const attributes: LogAttributes = {
      ...(record.properties as LogAttributes),
      'log.category': record.category.join('.'),
    }

    // logtape's rawMessage is a string for method-call syntax (logger.info('Hello, {name}!', {
    // name })), in which case the placeholders are left unsubstituted in the body and the
    // values ride in `attributes` via record.properties instead. For tagged-template syntax
    // (logger.info`hello ${name}!`), rawMessage is a TemplateStringsArray of literal segments
    // only, and logtape leaves `properties` empty — so the body must be rendered from
    // record.message, which interleaves the literal segments with the substituted values.
    const body =
      typeof record.rawMessage === 'string'
        ? record.rawMessage
        : record.message.map(renderMessagePart).join('')

    logger.emit({
      severityNumber: LEVEL_TO_SEVERITY[record.level],
      severityText: record.level,
      body,
      attributes,
      timestamp: record.timestamp,
      context: activeSpan ? context.active() : undefined,
    })
  }
}
