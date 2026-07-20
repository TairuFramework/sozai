# otel — `log-sink` forwards the active context to the logs SDK unguarded

**Status:** open · low priority
**Source:** final whole-branch review of the span ID validation work (2026-07-19). Pre-existing;
explicitly kept out of scope of that branch because it predates it and is a parallel path.

`packages/otel/src/log-sink.ts:49,70` calls `trace.getSpan(context.active())` and, if a span comes
back, passes `context.active()` wholesale into `logger.emit({ context })`. The OTel logs SDK
derives the log record's trace and span IDs from that context.

So a span context that the guards in `traceLogger` / `getActiveTraceContext` now reject can still
get its zero IDs onto an emitted log record by this route. The sink itself reads no span context —
the reading is delegated — which is why "log-sink calls no guard, therefore it is unaffected" does
not hold.

## Why it was deferred

Entirely pre-existing, and identically true of the all-zero **trace** ID that was guarded against
before the 2026-07-19 work — so that branch neither created nor widened the asymmetry. See
[the completed record](../completed/2026-07-19-otel-span-id-validation.complete.md) for the
guards it did add.

Impact is also unverified: the package depends only on `@opentelemetry/api-logs`, and the actual
ID-stamping lives in whatever logs SDK the consumer installs. Establish what a real SDK does with a
zeroed context before deciding whether this needs a guard at all.

## If it turns out to matter

The predicate already exists — `isValidSpanContext` in `packages/otel/src/span-context.ts`,
internal by design (the public surface is frozen). Guarding the sink means checking the active
span's context before forwarding, and deciding what to emit instead: no context, or a context with
the span stripped.
