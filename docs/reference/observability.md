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
| `LogRecord` | type | LogTape's log record shape, re-exported so consumers (e.g. `@sozai/otel`'s log sink) don't need a direct `@logtape/logtape` dependency. |

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
| `createTracerFactory` | function | `createTracerFactory(prefix, version?)` — returns a `(name: string) => Tracer` factory; each call registers a tracer as `<prefix>.<name>`. `version` is the *consuming* package's version (reported as the instrumentation-scope version), not `@sozai/otel`'s. |
| `withSpan` | function | `withSpan(tracer, name, options, fn, parentContext?)` — start an active span, await `fn(span)`, end the span. Leaves the span status `Unset` on success (per OTel guidance) and sets `ERROR` on a thrown error. Async. |
| `withSyncSpan` | function | Same contract as `withSpan` but synchronous. |
| `getActiveSpan` | function | Return the currently active `Span`, or `undefined` if none. |
| `withActiveContext` | function | `withActiveContext(ctx, fn)` — run `fn` inside the given OTel `Context` (or the current active context when `undefined`). |
| `setSpanOnContext` | function | Attach a `Span` to a `Context` and return the new `Context`. |
| `TraceContext` | type | `{ traceID: string; spanID: string; traceFlags: number }` |

#### Context propagation

| Symbol | Kind | Description |
|---|---|---|
| `injectW3CTraceContext` | function | Stamp `traceparent` (and `tracestate`, when present) onto a meta record from the active span. Returns the record unchanged when there is no active span, or when the active span cannot produce a valid header. |
| `extractW3CTraceContext` | function | Parse `traceparent` (and optional `tracestate`) from a meta record into a remote-span OTel `Context`. |
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
| `formatTraceparent` | function | `formatTraceparent(traceID, spanID, traceFlags)` → W3C `traceparent` string (`00-<traceID>-<spanID>-<flags>`), or `undefined` when the trace ID, span ID, or flags cannot produce a valid header (e.g. all-zero IDs or out-of-range flags). |
| `parseTraceparent` | function | Parse a W3C `traceparent` string → `TraceparentData \| undefined`. Accepts version `00` and, per the spec's forward-compatibility rule, higher versions (parsing their first four fields and ignoring any trailing content); rejects version `ff` and all-zero trace/span IDs. |
| `formatTracestate` | function | Serialize `Array<TracestateEntry>` → W3C `tracestate` string (drops invalid members, drops duplicate keys keeping the first occurrence, caps at 32 entries, caps the serialized header at 512 characters by dropping whole trailing members from the end — not full W3C §3.3.3 conformance, which would first drop oversized list-members, largest first). |
| `parseTracestate` | function | Parse a W3C `tracestate` string → `Array<TracestateEntry>` (drops malformed members, drops duplicate keys keeping the first occurrence, caps at 32 entries). |
| `TraceparentData` | type | `{ traceID: string; spanID: string; traceFlags: number }` |
| `TracestateEntry` | type | `{ key: string; value: string }` |

#### Semantic constants

| Symbol | Kind | Description |
|---|---|---|
| `AttributeKeys` | const | Predefined OTel semantic attribute-key strings for instrumenting spans consistently across the stack. |
| `ZERO_TRACE_ID` | const | The all-zero trace ID (`'00000000000000000000000000000000'`); used to detect no-op spans. |

#### ID validation

| Symbol | Kind | Description |
|---|---|---|
| `isValidTraceID` | function | Whether a string is a valid W3C trace ID: 32 lowercase hex characters, not all-zero. |
| `isValidSpanID` | function | Whether a string is a valid W3C span ID: 16 lowercase hex characters, not all-zero. |

#### Bridge (`@sozai/log` ↔ OTel)

| Symbol | Kind | Description |
|---|---|---|
| `createOTelLogSink` | function | Return a LogTape sink that emits records via the OTel Logs API, attaching the active span context so log records correlate with traces. Tagged-template calls (`` logger.info`hello ${name}!` ``) render the body from `record.message`, interpolated values included; method-call calls (`logger.info('hello {name}!', { name })`) keep placeholders in the body and carry values in `attributes`, as before. An interpolated value that cannot be rendered any other way falls back to the literal placeholder `[unrenderable]` in the body, rather than throwing or silently dropping the log record. |
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
import { createTracerFactory, withSpan } from '@sozai/otel'

// `version` is your package's version (e.g. `require('../package.json').version`),
// reported as the OTel instrumentation-scope version.
const createTracer = createTracerFactory('myapp', '1.0.0')
const tracer = createTracer('worker')

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
  createTracerFactory,
  extractW3CTraceContext,
  injectW3CTraceContext,
  withActiveContext,
  withSpan,
} from '@sozai/otel'

const tracer = createTracerFactory('myapp', '1.0.0')('handler')

// On the receiving side: restore a parent span context from W3C headers.
async function handle(meta: Record<string, unknown>): Promise<void> {
  const parentCtx = extractW3CTraceContext(meta) // parses meta.traceparent + meta.tracestate
  await withActiveContext(parentCtx, () =>
    withSpan(tracer, 'handle', {}, async (span) => {
      // span is a child of the upstream caller's span
    }),
  )
}

// On the sending side: stamp traceparent (and tracestate) from the active span.
function buildMeta(): Record<string, unknown> {
  return injectW3CTraceContext({})
}
```

### Example — log/trace bridge

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

---

## When to use

- **`@sozai/log`** — any structured application or library logging. Call `setup` once at the process entry point; use `getLogger` or `getSozaiLogger` everywhere else.
- **`@sozai/otel`** — distributed tracing and W3C context propagation. Use `createTracerFactory` + `withSpan`/`withSyncSpan` to instrument operations; use `injectW3CTraceContext` + `extractW3CTraceContext` for W3C `traceparent`/`tracestate` propagation across a request boundary.
- **Bridge** — when you want log records correlated with traces in your OTel backend: add `createOTelLogSink()` as a LogTape sink at startup, and wrap per-request loggers with `traceLogger`.
