# Observability

Structured logging (LogTape) and OpenTelemetry tracing/baggage utilities.

## Packages

| Package | Purpose |
|---|---|
| `@sozai/log` | Structured logging via [LogTape](https://logtape.org) |
| `@sozai/otel` | OpenTelemetry tracing, context propagation, and baggage |

The two packages bridge through `createOTelLogSink` (emit log records as OTel log records) and `traceLogger` (stamp a `Logger` with the active span's trace/span IDs).

---

## @sozai/log

Thin wrapper over LogTape. Provides a one-call setup path and typed re-exports so consumers only need `@sozai/log`.

### Exports

| Symbol | Kind | Description |
|---|---|---|
| `getLogger` | function | Return a `Logger` scoped to `name` (string or (readonly) category array), optionally pre-bound with `properties`. |
| `getSozaiLogger` | function | Shorthand: `getLogger(['sozai', namespace], properties)`. |
| `getDefaultConfig` | function | Build a minimal `Config` that writes to the console sink at `error` level for both `logtape.meta` and `sozai` categories. Accepts optional `ConsoleSinkOptions`. |
| `setup` | function | Configure LogTape synchronously. Calls `getDefaultConfig()` when no argument is provided. |
| `getConsoleSink` | function | Re-export from LogTape. Create a console sink directly. |
| `Config` | type | LogTape configuration shape. |
| `ConsoleSinkOptions` | type | Options for the console sink. |
| `Logger` | type | LogTape logger instance. |
| `LogLevel` | type | `'trace' \| 'debug' \| 'info' \| 'warning' \| 'error' \| 'fatal'` |

### Example — bootstrap and log

```ts
import { getDefaultConfig, getLogger, setup } from '@sozai/log'

// Call once at startup (e.g. in your entry point).
setup(getDefaultConfig())

const logger = getLogger(['myapp', 'server'])
logger.info('listening on {port}', { port: 3000 })

// For sozai-internal namespaces:
// const logger = getSozaiLogger('runtime', { region: 'eu-1' })
```

`setup` without arguments applies `getDefaultConfig()`, which routes `sozai.*` and `logtape.meta` at `error` level to the console. Pass a custom `Config` to extend categories, sinks, or levels.

---

## @sozai/otel

OpenTelemetry utilities: tracer helpers, W3C context propagation, baggage codec, semantic constants, and a bridge to `@sozai/log`. All OTel types needed for day-to-day use are re-exported so consumers do not take a direct peer dependency on `@opentelemetry/api`.

### Exports

#### Tracing

| Symbol | Kind | Description |
|---|---|---|
| `createTracer` | function | `createTracer(name)` — returns a `Tracer` registered as `sozai.<name>`. |
| `withSpan` | function | `withSpan(tracer, name, options, fn, parentContext?)` — start an active span, await `fn(span)`, set OK/ERROR status, end the span. Async. |
| `withSyncSpan` | function | Same contract as `withSpan` but synchronous. |
| `getActiveSpan` | function | Return the currently active `Span`, or `undefined` if none. |
| `withActiveContext` | function | `withActiveContext(ctx, fn)` — run `fn` inside the given OTel `Context` (or the current active context when `undefined`). |
| `setSpanOnContext` | function | Attach a `Span` to a `Context` and return the new `Context`. |
| `TraceContext` | type | `{ traceID: string; spanID: string; traceFlags: number }` |

#### Context propagation

| Symbol | Kind | Description |
|---|---|---|
| `extractTraceContext` | function | Extract `tid`/`sid` fields from an arbitrary header record and return an OTel `Context` with a remote `SpanContext`. |
| `extractW3CTraceContext` | function | Parse `traceparent` (and optional `tracestate`) from a meta record into a remote-span OTel `Context`. |
| `injectTraceContext` | function | Stamp `tid`/`sid` onto a header record from the active span. Returns the header unchanged when no active span exists. |
| `getActiveTraceContext` | function | Return the active span's `{ traceID, spanID, traceFlags }`, or `undefined` when no real span is active (guards against no-op all-zero IDs). |

#### Baggage

| Symbol | Kind | Description |
|---|---|---|
| `baggageToEntries` | function | Convert an OTel `Baggage` to `Array<BaggageEntry>`, parsing OTel's opaque metadata string back into structured `properties`. |
| `entriesToBaggage` | function | Inverse: convert `Array<BaggageEntry>` to an OTel `Baggage`. |
| `formatBaggage` | function | Serialize `Array<BaggageEntry>` to a W3C `baggage` header value (percent-encodes values, drops invalid members). |
| `parseBaggage` | function | Parse a W3C `baggage` header value to `Array<BaggageEntry>` (percent-decodes, drops malformed members, deduplicates). |
| `getActiveBaggage` | function | Return the active propagation baggage as `Array<BaggageEntry>`, or `undefined`. |
| `withActiveBaggage` | function | `withActiveBaggage(entries, fn)` — run `fn` with the given baggage entries active in context. |
| `BaggageEntry` | type | `{ key: string; value: string; properties?: Array<BaggageProperty> }` |
| `BaggageProperty` | type | `{ key: string; value?: string }` |

#### W3C headers

| Symbol | Kind | Description |
|---|---|---|
| `formatTraceparent` | function | `formatTraceparent(traceID, spanID, traceFlags)` → W3C `traceparent` string (`00-<traceID>-<spanID>-<flags>`). |
| `parseTraceparent` | function | Parse a W3C `traceparent` string → `TraceparentData \| undefined`. Only version `00` is supported. |
| `formatTracestate` | function | Serialize `Array<TracestateEntry>` → W3C `tracestate` string (drops invalid members, caps at 32 entries). |
| `parseTracestate` | function | Parse a W3C `tracestate` string → `Array<TracestateEntry>` (drops malformed members, caps at 32 entries). |
| `TraceparentData` | type | `{ traceID: string; spanID: string; traceFlags: number }` |
| `TracestateEntry` | type | `{ key: string; value: string }` |

#### Semantic constants

| Symbol | Kind | Description |
|---|---|---|
| `AttributeKeys` | const | Predefined OTel semantic attribute-key strings for instrumenting spans consistently across the stack. |
| `SpanNames` | const | Canonical span-name strings for consistent span naming across the stack. |
| `ZERO_TRACE_ID` | const | The all-zero trace ID (`'00000000000000000000000000000000'`); used to detect no-op spans. |

#### Bridge (`@sozai/log` ↔ OTel)

| Symbol | Kind | Description |
|---|---|---|
| `createOTelLogSink` | function | Return a LogTape sink that emits records via the OTel Logs API, attaching the active span context so log records correlate with traces. |
| `traceLogger` | function | `traceLogger(logger)` — return a `Logger` pre-bound with `{ traceID, spanID }` from the active span. Useful for per-request loggers. Returns the original logger unchanged when no real span is active. |

#### Re-exports from `@opentelemetry/api`

| Symbol | Kind |
|---|---|
| `Context` | type |
| `Span` | type |
| `SpanOptions` | type |
| `SpanStatusCode` | enum |
| `TraceFlags` | enum |
| `Tracer` | type |

### Example — tracer and span

```ts
import { createTracer, withSpan } from '@sozai/otel'

const tracer = createTracer('myapp')

async function processItem(id: string): Promise<void> {
  await withSpan(tracer, 'processItem', { attributes: { 'item.id': id } }, async (span) => {
    // span is the active OTel Span for this scope
    span.addEvent('started')
    // ... work ...
    span.addEvent('done')
  })
}
```

### Example — W3C context propagation

```ts
import {
  extractW3CTraceContext,
  formatTraceparent,
  getActiveTraceContext,
  withActiveContext,
  withSpan,
  createTracer,
} from '@sozai/otel'

const tracer = createTracer('myapp')

// On the receiving side: restore a parent span context from W3C headers.
async function handle(meta: Record<string, unknown>): Promise<void> {
  const parentCtx = extractW3CTraceContext(meta) // parses meta.traceparent + meta.tracestate
  await withActiveContext(parentCtx, () =>
    withSpan(tracer, 'handle', {}, async (span) => {
      // span is a child of the upstream caller's span
    }),
  )
}

// On the sending side: build a traceparent header from the active span.
function buildMeta(): Record<string, unknown> {
  const ctx = getActiveTraceContext()
  if (ctx == null) return {}
  return { traceparent: formatTraceparent(ctx.traceID, ctx.spanID, ctx.traceFlags) }
}
```

### Example — log/trace bridge

```ts
import { getConsoleSink, getLogger, setup } from '@sozai/log'
import { createOTelLogSink, traceLogger, withSpan, createTracer } from '@sozai/otel'

// At startup: plug OTel sink into LogTape.
setup({
  sinks: { console: getConsoleSink(), otel: createOTelLogSink() },
  loggers: [{ category: ['myapp'], lowestLevel: 'info', sinks: ['console', 'otel'] }],
})

const tracer = createTracer('myapp')
const baseLogger = getLogger(['myapp'])

await withSpan(tracer, 'request', {}, async (span) => {
  // Logger stamped with traceID + spanID from the active span.
  const logger = traceLogger(baseLogger)
  logger.info('handling request')
})
```

---

## When to use

- **`@sozai/log`** — any structured application or library logging. Call `setup` once at the process entry point; use `getLogger` or `getSozaiLogger` everywhere else.
- **`@sozai/otel`** — distributed tracing and W3C context propagation. Use `createTracer` + `withSpan`/`withSyncSpan` to instrument operations; use `extractW3CTraceContext` + `formatTraceparent` for W3C `traceparent` propagation, or `extractTraceContext` + `injectTraceContext` for the custom `tid`/`sid` header contract.
- **Bridge** — when you want log records correlated with traces in your OTel backend: add `createOTelLogSink()` as a LogTape sink at startup, and wrap per-request loggers with `traceLogger`.
