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
// and silently drops the record. This must never throw and must never silently
// drop the value:
//
// - If JSON.stringify throws (BigInt, a circular structure, a `toJSON` that
//   throws), fall back to `String(part)` (e.g. `[object Object]` for a
//   circular value, `'10'` for `10n`).
// - JSON.stringify also *returns `undefined`* (not a string, despite the
//   `: string` return type) for a symbol, a function, or `undefined` in an
//   interpolated position. That is not a throw, so it must be checked for
//   explicitly, or the value silently vanishes from the body. It falls
//   through to the same `String(part)` path, which renders it visibly
//   (`Symbol(x)`, the function source, `'undefined'`).
// - `String(part)` can itself throw — a null-prototype object has no
//   `Object.prototype.toString` to fall back to, and an object whose
//   `toString`/`Symbol.toPrimitive` throws propagates that — so the fallback
//   is guarded too, with `'[unrenderable]'` as the last-resort placeholder.
function renderMessagePart(part: unknown, index: number): string {
  if (typeof part === 'string') {
    return part
  }
  // Literal template segments (even indices) are always strings from
  // TemplateStringsArray, so JSON-rendering is only attempted for interpolated
  // (odd-index) values — but that's not relied on for safety: an even-index
  // value that somehow isn't a string still falls through to the guarded
  // `String(part)`/`[unrenderable]` path below, so "must never throw" holds
  // unconditionally rather than depending on that assumption.
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
