# otel — `traceLogger` / `getActiveTraceContext` validate the trace ID but not the span ID

**Status:** open · low priority
**Source:** whole-branch review of the W3C compliance work (2026-07-14). Pre-existing; explicitly
kept out of scope of that branch because it predates it and is consistent between the two call sites.

Both `traceLogger` (`packages/otel/src/logger.ts`) and `getActiveTraceContext`
(`packages/otel/src/tracers.ts`) guard against no-op spans with `isValidTraceID(ctx.traceId)` only.
Neither checks the span ID.

So a span context with a valid trace ID and an **all-zero span ID** passes the guard, and
`spanID: '0000000000000000'` gets stamped onto every log line and returned from
`getActiveTraceContext()`.

`isValidSpanID` already exists in `packages/otel/src/span-context.ts` and is now publicly exported —
the fix is a one-line addition at each of the two sites, plus a test.

## Why it was deferred

Unreachable with a real OTel SDK: SDK-created spans always carry a well-formed span ID, and OTel's
own `INVALID_SPAN_CONTEXT` has an all-zero trace ID too, so the existing trace-ID guard catches it.
It only bites a hand-constructed or malformed remote span context — which the W3C path now rejects
at parse time anyway.

Worth fixing for symmetry, not urgency.
