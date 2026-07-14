# otel — W3C Trace Context compliance

**Source:** [next/otel-w3c-compliance.md](../../agents/plans/next/otel-w3c-compliance.md) ·
[audit 2026-07-02 — otel](../../agents/plans/completed/2026-07-02-repo-audit.complete.md#otel)
**Package:** `@sozai/otel` (0.2.0) · freeze-blocker

## Problem

`@sozai/otel` violates W3C Trace Context in ways that produce invalid remote `SpanContext`s and
force-sampled traces:

- All-zero trace IDs and span IDs are accepted and turned into `SpanContext`s that SDKs parent
  real spans to.
- The custom `tid`/`sid` header path hardcodes `TraceFlags.SAMPLED` and skips ID validation
  entirely, so every remote trace is force-sampled and any garbage string becomes a `SpanContext`.
- `formatTraceparent` can emit structurally invalid headers (unmasked flags, unchecked IDs).
- Future traceparent versions are rejected outright; the spec says implementations SHOULD parse
  the first four fields of a higher version.
- `formatTracestate` does not dedupe keys, though `parseTracestate` does.

Alongside these, three hygiene defects: a hardcoded instrumentation version that is both stale and
semantically wrong, `setStatus(OK)` on every successful span against OTel guidance, and a
hand-copied `LogRecord` type in the log sink that has drifted from logtape's real one.

## Root cause

Two independent trace-context code paths exist. The W3C path (`traceparent`/`tracestate`) validates
IDs and honours flags. The custom path (`tid`/`sid` fields on a JSON message header) is a second,
worse encoding of the same three values — trace ID, span ID, flags — with its own validation (none)
and its own bugs. Patching the custom path to parity would leave two formats and two places for the
next bug to land.

Nothing in the stack consumes `injectTraceContext`/`extractTraceContext` — a search across all
sibling repos finds them only in documentation. The custom format is unshipped, so it can be
removed rather than repaired.

## Design

### Single validation authority

A new internal module `src/span-context.ts` owns all trace-ID/span-ID validation and remote
`SpanContext` construction:

```ts
export function isValidTraceID(value: string): boolean
export function isValidSpanID(value: string): boolean
export function toRemoteSpanContext(
  data: TraceparentData,
  traceState?: TraceState,
): SpanContext | undefined
```

- `isValidTraceID` — exactly 32 lowercase hex characters, not all-zero (`ZERO_TRACE_ID`).
- `isValidSpanID` — exactly 16 lowercase hex characters, not all-zero. This needs a `ZERO_SPAN_ID`
  counterpart; it lives in `semantic.ts` beside `ZERO_TRACE_ID` but stays internal — nothing outside
  the package has a use for it, and `ZERO_TRACE_ID` is only public because it predates this work.
- `toRemoteSpanContext` — returns `undefined` when either ID is invalid; otherwise a `SpanContext`
  with `isRemote: true` and the flags from the parsed data.

`traceparent.ts` and `context.ts` both route through it. Validation exists once, so there is no
second copy to drift.

### Public API changes

| Symbol | Change |
|---|---|
| `injectTraceContext` | **removed** |
| `extractTraceContext` | **removed** |
| `injectW3CTraceContext(meta)` | **new** — stamps `traceparent` (+ `tracestate`) from the active span; returns `meta` unchanged when there is no valid active span |
| `formatTraceparent(traceID, spanID, traceFlags)` | return type widens to `string \| undefined` |
| `createTracerFactory(prefix, version?)` | new optional `version` parameter |
| `ZERO_TRACE_ID` | unchanged; still exported as the OTel no-op-span guard, and now also backs `isValidTraceID` |

The `tid`/`sid` contract is replaced by the W3C one. A JSON message header carries a 55-character
`traceparent` string instead of two fields — no meaningful size cost in an envelope that already
carries a request ID and a procedure name.

### Wire-format behaviour

**`parseTraceparent`** returns `undefined` for a malformed header, an all-zero trace ID, an all-zero
span ID, or version `ff` (the spec declares `ff` invalid).

Version handling follows the spec's SHOULD for forward compatibility:

- Version `00` — exactly four fields. A trailing field makes the header malformed, not future, so
  it is rejected.
- Version `01`–`fe` — parse the first four fields and ignore any trailing content.

Unknown flag bits from a future version are preserved on the returned number but never interpreted;
only bit 0 (sampled) is ever read. The two-hex-digit capture already bounds the value, so no mask
is needed on the parse side.

**`formatTraceparent`** validates both IDs through `span-context.ts` and returns `undefined` rather
than emitting a structurally invalid header. `traceFlags` must be an integer in `[0, 255]`;
anything else returns `undefined`.

The audit proposed masking with `& 0xff`, but a mask is the wrong repair: it turns `256` into `00`,
silently flipping a sampled trace to unsampled. A caller passing an out-of-range flag has a bug, and
dropping the header surfaces it. Rejecting mirrors `parseTraceparent` and keeps telemetry
off the caller's failure path: an omitted header is the correct wire outcome, since no trace beats a
corrupt trace.

**`formatTracestate`** dedupes keys, keeping the first occurrence, matching `parseTracestate`. The
32-entry cap counts deduped entries, so a header carrying 40 duplicates of one key yields one entry
rather than a burst of drop warnings.

**`injectW3CTraceContext`** reads the active span and bails when there is none, or when
`formatTraceparent` returns `undefined`. That second condition subsumes the all-zero no-op-span case,
so no separate `ZERO_TRACE_ID` check is needed at the call site. `tracestate` is stamped only when
the span carries a non-empty one.

**`extractW3CTraceContext`** keeps its shape. Its IDs are now validated before the `SpanContext` is
built, and with `extractTraceContext` gone there is no force-sampling path left in the package.

### Tracer

`createTracerFactory(prefix, version?)` passes `version` through to `trace.getTracer`; `undefined` is
a legal instrumentation-scope version.

The hardcoded `OTEL_PACKAGE_VERSION = '0.1.0'` is not merely stale — it is the wrong version. Tracer
names are `` `${prefix}.${name}` `` where `prefix` identifies the *consuming* package, and OTel
defines the instrumentation-scope version as the version of the instrumentation library. That is the
consumer's version, not `@sozai/otel`'s. The caller supplies it.

`setStatus({ code: SpanStatusCode.OK })` is removed from both `withSpan` and `withSyncSpan`. OTel
reserves `Ok` for an explicit application override; instrumentation leaves the status `Unset`, which
backends read as success. The `ERROR` path is unchanged.

### Log sink

`log-sink.ts` drops its local `LogRecord` type and imports logtape's. `@sozai/log` re-exports the
type — it already re-exports `Config`, `Logger`, and `LogLevel`, so this follows the established
pattern and keeps `@logtape/logtape` a dependency of one package.

The copy has drifted in two ways, both fixed by the import:

- Its `level` is `string` and its severity map carries both `warning` and `warn`. Logtape's real
  `LogLevel` is `'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal'` — there is no `warn`.
  `LEVEL_TO_SEVERITY` becomes an exhaustive `Record<LogLevel, SeverityNumber>`, which drops both the
  dead `warn` key and the `?? 9` fallback.
- Its `rawMessage` is `string`, but logtape's is `string | TemplateStringsArray`. The sink assigns
  `rawMessage` straight to the OTel log body, so any tagged-template call site
  (`` logger.info`hello ${name}` ``) currently emits a raw array as the body. This is a shipped bug.
  The body becomes `typeof rawMessage === 'string' ? rawMessage : rawMessage.join('')`.

## Testing

New coverage, driven from the W3C spec's own examples where they exist:

- All-zero trace ID and all-zero span ID rejected on parse and on format.
- Version `ff` rejected. Version `01` with a trailing field parsed down to its first four fields.
  Version `00` with a trailing field rejected.
- `formatTraceparent` rejects flags ≥ 256, negative flags, non-integer flags, and short, long, or
  uppercase IDs.
- `formatTracestate` dedupes keys, and dedupe runs before the 32-entry cap.
- `injectW3CTraceContext` no-ops with no active span and with a no-op (all-zero) span, and
  round-trips through `extractW3CTraceContext`.
- Log sink: a tagged-template `rawMessage` produces a string body; every `LogLevel` maps to a
  severity number.

## Release

Breaking: two exports removed, one return type widened, one sink body-encoding fixed. The package is
pre-1.0 and this is a freeze-blocker, so it ships as a `minor` changeset with the removals named
explicitly in the summary. There are no consumers to migrate.

`docs/reference/observability.md` needs its context-propagation table updated: drop the
`tid`/`sid` rows, add `injectW3CTraceContext`, and rewrite the "When to use" line that currently
offers the custom header contract as an alternative.

## Out of scope

- Baggage (`baggage.ts`) — not implicated by the audit.
- A full W3C test-suite harness. The listed cases cover the spec's requirements that this package
  can violate.
