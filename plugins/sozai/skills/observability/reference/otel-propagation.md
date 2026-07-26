# @sozai/otel — context propagation and baggage

Sibling references: `reference/otel.md` (tracer and spans), `reference/otel-log-bridge.md` (log/trace bridge).

### Context propagation

| Symbol | Kind | Description |
|---|---|---|
| `injectW3CTraceContext` | function | Stamp `traceparent` (and `tracestate`, when present) onto a meta record from the active span. Returns the record unchanged when there is no active span, or when the active span cannot produce a valid header. |
| `extractW3CTraceContext` | function | Parse `traceparent` (and optional `tracestate`) from a meta record into a remote-span OTel `Context`. |
| `getActiveTraceContext` | function | Return the active span's `{ traceID, spanID, traceFlags }`, or `undefined` when no real span is active (guards against no-op all-zero IDs). |

### Baggage

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

### W3C headers

| Symbol | Kind | Description |
|---|---|---|
| `formatTraceparent` | function | `formatTraceparent(traceID, spanID, traceFlags)` → W3C `traceparent` string (`00-<traceID>-<spanID>-<flags>`), or `undefined` when the trace ID, span ID, or flags cannot produce a valid header (e.g. all-zero IDs or out-of-range flags). |
| `parseTraceparent` | function | Parse a W3C `traceparent` string → `TraceparentData \| undefined`. Accepts version `00` and, per the spec's forward-compatibility rule, higher versions (parsing their first four fields and ignoring any trailing content); rejects version `ff` and all-zero trace/span IDs. |
| `formatTracestate` | function | Serialize `Array<TracestateEntry>` → W3C `tracestate` string (drops invalid members, drops duplicate keys keeping the first occurrence, caps at 32 entries, caps the serialized header at 512 characters by dropping whole trailing members from the end — not full W3C §3.3.3 conformance, which would first drop oversized list-members, largest first). |
| `parseTracestate` | function | Parse a W3C `tracestate` string → `Array<TracestateEntry>` (drops malformed members, drops duplicate keys keeping the first occurrence, caps at 32 entries). |
| `TraceparentData` | type | `{ traceID: string; spanID: string; traceFlags: number }` |
| `TracestateEntry` | type | `{ key: string; value: string }` |

## Example — W3C context propagation

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
