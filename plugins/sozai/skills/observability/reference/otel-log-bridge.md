# @sozai/otel — log/trace bridge

Sibling references: `reference/otel.md` (tracer and spans), `reference/otel-propagation.md` (context, baggage, W3C headers).

### Bridge (`@sozai/log` ↔ OTel)

| Symbol | Kind | Description |
|---|---|---|
| `createOTelLogSink` | function | Return a LogTape sink that emits records via the OTel Logs API, attaching the active span context so log records correlate with traces. Tagged-template calls (`` logger.info`hello ${name}!` ``) render the body from `record.message`, interpolated values included; method-call calls (`logger.info('hello {name}!', { name })`) keep placeholders in the body and carry values in `attributes`, as before. An interpolated value that cannot be rendered any other way falls back to the literal placeholder `[unrenderable]` in the body, rather than throwing or silently dropping the log record. |
| `traceLogger` | function | `traceLogger(logger)` — return a `Logger` pre-bound with `{ traceID, spanID }` from the active span. Useful for per-request loggers. Returns the original logger unchanged when no real span is active. |

## Example — log/trace bridge

```ts
import { getConsoleSink, getLogger, setup } from '@sozai/log'
import { createOTelLogSink, createTracerFactory, traceLogger, withSpan } from '@sozai/otel'

// At startup: plug OTel sink into LogTape.
setup({
  sinks: { console: getConsoleSink(), otel: createOTelLogSink() },
  loggers: [{ category: ['myapp'], lowestLevel: 'info', sinks: ['console', 'otel'] }],
})

const tracer = createTracerFactory('myapp', '1.0.0')('request')
const baseLogger = getLogger(['myapp'])

await withSpan(tracer, 'request', {}, async (span) => {
  // Logger stamped with traceID + spanID from the active span.
  const logger = traceLogger(baseLogger)
  logger.info('handling request')
})
```
