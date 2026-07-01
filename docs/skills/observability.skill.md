---
name: sozai:observability
description: Structured logging and OpenTelemetry tracing patterns for sozai packages.
---

# sozai:observability

Patterns for `@sozai/log` (structured logging) and `@sozai/otel` (OpenTelemetry tracing, context propagation, baggage).

---

## Pattern 1: Logger setup and use

Call `setup` once at the process entry point. Use `getLogger` everywhere else.

```ts
import { getConsoleSink, getDefaultConfig, getLogger, getSozaiLogger, setup } from '@sozai/log'

// Entry point (called once):
setup(getDefaultConfig())
// Or with custom options, e.g. to lower the level:
// setup({ sinks: { console: getConsoleSink() }, loggers: [{ category: ['myapp'], lowestLevel: 'debug', sinks: ['console'] }] })

// In a module:
const logger = getLogger(['myapp', 'worker'])
logger.info('starting worker {id}', { id: 'w-1' })
logger.error('worker failed {id}', { id: 'w-1' })

// For sozai-internal namespaces (prefixes ['sozai', namespace]):
const slogger = getSozaiLogger('runtime', { region: 'eu-1' })
slogger.debug('subsystem ready')
```

**Key points:**
- `getDefaultConfig()` routes `sozai.*` and `logtape.meta` at `error` level to the console. Pass a custom `Config` to add categories, change levels, or add sinks.
- `getLogger(name, properties)` binds `properties` once so every log record from that logger carries them — useful for request IDs, component names, etc.
- `getSozaiLogger(namespace, properties)` is a shorthand for `getLogger(['sozai', namespace], properties)`.

---

## Pattern 2: Tracer, spans, and W3C context propagation

```ts
import {
  createTracer,
  extractW3CTraceContext,
  formatTraceparent,
  getActiveTraceContext,
  withActiveContext,
  withSpan,
  withSyncSpan,
} from '@sozai/otel'

const tracer = createTracer('myapp')

// --- Instrument an async operation ---
async function processItem(id: string): Promise<void> {
  await withSpan(tracer, 'processItem', { attributes: { 'item.id': id } }, async (span) => {
    span.addEvent('processing')
    // ... work ...
    // span.setStatus / span.recordException are handled automatically on throw
  })
}

// --- Instrument a synchronous operation ---
function validateItem(id: string): boolean {
  return withSyncSpan(tracer, 'validateItem', {}, (_span) => {
    return id.length > 0
  })
}

// --- Receive a parent context from W3C headers ---
async function handleIncoming(meta: Record<string, unknown>): Promise<void> {
  const parentCtx = extractW3CTraceContext(meta) // reads meta.traceparent + meta.tracestate
  await withActiveContext(parentCtx, () =>
    withSpan(tracer, 'handle', {}, async (_span) => {
      // span is a child of the upstream caller
    }),
  )
}

// --- Inject the active span into outgoing headers ---
function outgoingMeta(): Record<string, unknown> {
  const ctx = getActiveTraceContext()
  if (ctx == null) return {}
  return { traceparent: formatTraceparent(ctx.traceID, ctx.spanID, ctx.traceFlags) }
}
```

**Key points:**
- `createTracer(name)` registers a tracer as `sozai.<name>`. Create one per logical component, reuse it.
- `withSpan` / `withSyncSpan` automatically set `SpanStatusCode.OK` on success and `SpanStatusCode.ERROR` (with `recordException`) on throw.
- `extractW3CTraceContext` returns `undefined` when no valid `traceparent` is present — pass that `undefined` to `withActiveContext` and it falls back to the current active context with no overhead.
- `getActiveTraceContext()` guards against no-op all-zero spans (e.g. when the SDK is not installed), returning `undefined` rather than a meaningless ID.

---

## Pattern 3: Log/trace bridge

Wire `createOTelLogSink` as a LogTape sink so log records are emitted as OTel log records and correlated with the active span. Use `traceLogger` to stamp a `Logger` with the current span's IDs.

```ts
import { getConsoleSink, getLogger, setup } from '@sozai/log'
import { createOTelLogSink, createTracer, traceLogger, withSpan } from '@sozai/otel'

// At startup:
setup({
  sinks: {
    console: getConsoleSink(),
    otel: createOTelLogSink(),
  },
  loggers: [
    { category: ['myapp'], lowestLevel: 'info', sinks: ['console', 'otel'] },
  ],
})

const tracer = createTracer('myapp')
const baseLogger = getLogger(['myapp'])

// Inside a span, stamp the logger with trace/span IDs:
await withSpan(tracer, 'request', {}, async (_span) => {
  const logger = traceLogger(baseLogger)
  logger.info('handling request')
  // log record carries { traceID, spanID } and is emitted via the OTel Logs API
})
```

**Key points:**
- `createOTelLogSink()` returns a LogTape sink function — pass it as a value in the `sinks` map.
- `traceLogger(logger)` returns the original logger unchanged when no real span is active (safe to call unconditionally).
- The OTel Logs sink attaches `context.active()` to each emitted record, so trace correlation works automatically in compatible backends.

---

## See also

- Domain reference: [docs/reference/observability.md](../reference/observability.md)
- Related domains: [sozai:validation](validation.skill.md), [sozai:dataflow](dataflow.skill.md), [sozai:runtime](runtime.skill.md)
