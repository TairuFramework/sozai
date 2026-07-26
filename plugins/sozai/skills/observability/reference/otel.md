# @sozai/otel — tracing

Sibling references: `reference/otel-propagation.md` (context, baggage, W3C headers), `reference/otel-log-bridge.md` (log/trace bridge).

OpenTelemetry utilities: tracer helpers, W3C context propagation, baggage codec, semantic constants, and a bridge to `@sozai/log`. All OTel types needed for day-to-day use are re-exported so consumers do not take a direct peer dependency on `@opentelemetry/api`.

## Exports

### Tracing

| Symbol | Kind | Description |
|---|---|---|
| `createTracerFactory` | function | `createTracerFactory(prefix, version?)` — returns a `(name: string) => Tracer` factory; each call registers a tracer as `<prefix>.<name>`. `version` is the *consuming* package's version (reported as the instrumentation-scope version), not `@sozai/otel`'s. |
| `withSpan` | function | `withSpan(tracer, name, options, fn, parentContext?)` — start an active span, await `fn(span)`, end the span. Leaves the span status `Unset` on success (per OTel guidance) and sets `ERROR` on a thrown error. Async. |
| `withSyncSpan` | function | Same contract as `withSpan` but synchronous. |
| `getActiveSpan` | function | Return the currently active `Span`, or `undefined` if none. |
| `withActiveContext` | function | `withActiveContext(ctx, fn)` — run `fn` inside the given OTel `Context` (or the current active context when `undefined`). |
| `setSpanOnContext` | function | Attach a `Span` to a `Context` and return the new `Context`. |
| `TraceContext` | type | `{ traceID: string; spanID: string; traceFlags: number }` |

### Semantic constants

| Symbol | Kind | Description |
|---|---|---|
| `AttributeKeys` | const | Predefined OTel semantic attribute-key strings for instrumenting spans consistently across the stack. |
| `ZERO_TRACE_ID` | const | The all-zero trace ID (`'00000000000000000000000000000000'`); used to detect no-op spans. |

### ID validation

| Symbol | Kind | Description |
|---|---|---|
| `isValidTraceID` | function | Whether a string is a valid W3C trace ID: 32 lowercase hex characters, not all-zero. |
| `isValidSpanID` | function | Whether a string is a valid W3C span ID: 16 lowercase hex characters, not all-zero. |

### Re-exports from `@opentelemetry/api`

| Symbol | Kind |
|---|---|
| `Context` | type |
| `Span` | type |
| `SpanOptions` | type |
| `SpanStatusCode` | enum |
| `TraceFlags` | enum |
| `Tracer` | type |

## Example — tracer and span

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

## Example: synchronous span

```ts
import { createTracerFactory, withSyncSpan } from '@sozai/otel'

const tracer = createTracerFactory('myapp', '1.0.0')('worker')

function validateItem(id: string): boolean {
  return withSyncSpan(tracer, 'validateItem', {}, (_span) => {
    return id.length > 0
  })
}
```

Use `withSyncSpan` instead of `withSpan` when the instrumented operation does not await anything —
same span-lifecycle contract, no `Promise`.
