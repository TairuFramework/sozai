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

// Renders one segment of `record.message` (odd indices are interpolated values).
//
// Must never throw and never drop a value: logtape catches sink exceptions and
// silently discards the record, so one bad interpolation loses the whole log line.
// Three ways that happens, all guarded below:
//   - JSON.stringify throws on a BigInt, a circular structure, a throwing `toJSON`.
//   - JSON.stringify *returns undefined* (not a string) for a symbol, a function,
//     or `undefined` — no throw, so it needs an explicit check or the value vanishes.
//   - String() throws on a null-prototype object, or a throwing toString/Symbol.toPrimitive.
function renderMessagePart(part: unknown, index: number): string {
  if (typeof part === 'string') {
    return part
  }
  let rendered: string | undefined
  if (index % 2 !== 0) {
    try {
      rendered = JSON.stringify(part)
    } catch {
      rendered = undefined
    }
  }
  if (rendered !== undefined) {
    return rendered
  }
  try {
    return String(part)
  } catch {
    return '[unrenderable]'
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

    // Method-call syntax keeps its placeholders in the body; the values ride in attributes.
    // Tagged-template syntax can't: rawMessage holds the literal segments only and logtape
    // leaves `properties` empty, so the values exist nowhere but record.message.
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
