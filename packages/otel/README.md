# @sozai/otel

OpenTelemetry tracing, W3C context propagation, and baggage.

## Installation

```sh
pnpm add @sozai/otel
```

## Usage

```ts
import { createTracerFactory, withSpan } from '@sozai/otel'

// `version` is your package's version, reported as the OTel instrumentation-scope version.
const createTracer = createTracerFactory('myapp', '1.0.0')
const tracer = createTracer('worker')

async function processItem(id: string): Promise<void> {
  await withSpan(tracer, 'processItem', { attributes: { 'item.id': id } }, async (span) => {
    span.addEvent('started')
    // ... work ...
    span.addEvent('done')
  })
}
```

Also provides `withSyncSpan`, `injectW3CTraceContext`, `extractW3CTraceContext`, baggage codecs, and a `@sozai/log` bridge (`createOTelLogSink`, `traceLogger`) — see [the observability reference](../../docs/reference/observability.md) for the full API.
