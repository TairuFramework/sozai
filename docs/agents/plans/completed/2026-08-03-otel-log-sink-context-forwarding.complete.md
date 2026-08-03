# otel — `log-sink` context forwarding closed as a non-issue

**Status:** complete — closed without a code change
**Date:** 2026-08-03
**Packages:** none
**Source:** `backlog/2026-07-19-otel-log-sink-context-forwarding.md`, deleted by this closure.
Filed by the final whole-branch review of the
[span ID validation work](./2026-07-19-otel-span-id-validation.complete.md).

## Goal

Answer the question the backlog item was blocked on: what a real logs SDK does with a zeroed
span context, and therefore whether `createOTelLogSink` needs an `isValidSpanContext` guard
before forwarding `context.active()` to `logger.emit`.

## Answer

It needs none. The SDK already guards, so a zeroed or malformed span context never reaches a
log record.

`LogRecordImpl`'s constructor, `@opentelemetry/sdk-logs@0.221.0`:

```js
if (context) {
  const spanContext = api.trace.getSpanContext(context)
  if (spanContext && api.isSpanContextValid(spanContext)) {
    this._spanContext = spanContext
  }
}
```

Probed end to end through `LoggerProvider` → `SimpleLogRecordProcessor` →
`InMemoryLogRecordExporter`, emitting exactly the way the sink does — forward the whole active
context when `trace.getSpan(context.active())` returns a span:

| Active span context | `isSpanContextValid` | Landed on the record |
|---|---|---|
| valid | true | `0af76519../b7ad6b7169203331` |
| zero span ID, valid trace ID | false | none |
| zero trace ID, valid span ID | false | none |
| both zero | false | none |
| non-hex trace ID | false | none |

The same predicate gates `Logger.enabled`'s trace-based filtering, so an invalid context cannot
cause log records to be dropped either.

## Also established

`createOTelLogSink`'s `context: activeSpan ? context.active() : undefined` conditional is
load-bearing, which is not obvious: `Logger.emit` computes
`const currentContext = logRecord.context || context.active()`, which reads as though passing
`undefined` would fall back to the active context and make the conditional pointless. It does
not — the record is built with `new LogRecordImpl({ context: currentContext, ...logRecord })`,
and the spread puts the caller's explicit `undefined` back on top. Verified: emitting under a
valid active span with `context: undefined` produces a record with no span context.

## Scope of the claim

The reference JS SDK at the version line sozai's `@opentelemetry/api-logs` dependency tracks.
`@sozai/otel` depends only on `@opentelemetry/api` and `@opentelemetry/api-logs`; the
ID-stamping lives in whatever logs SDK a consumer installs. A non-JS or non-reference SDK that
stamps without validating would reintroduce the concern, which is why the guard was considered
rather than dismissed. `isValidSpanContext` stays in `packages/otel/src/span-context.ts` for the
paths that do need it.

## Not done

No guard added, no test added, no dependency added. Adding `@opentelemetry/sdk-logs` as a
devDependency purely to pin another package's guard was considered and rejected: it buys a
regression test for code sozai does not own.
