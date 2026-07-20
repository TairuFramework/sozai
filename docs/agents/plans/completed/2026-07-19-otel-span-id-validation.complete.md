# otel — validate the span ID alongside the trace ID

**Status:** complete
**Date:** 2026-07-19
**Packages:** `@sozai/otel` (patch)
**PR:** [#11](https://github.com/TairuFramework/sozai/pull/11)

## Goal

Close the span ID validation gap found by the 2026-07-14 whole-branch review of the W3C
compliance work: `traceLogger` and `getActiveTraceContext` validated the trace ID but not the
span ID, so an all-zero span ID could reach logs and callers.

## Problem fixed

Both `traceLogger` (`packages/otel/src/logger.ts`) and `getActiveTraceContext`
(`packages/otel/src/tracers.ts`) guarded against no-op spans with `isValidTraceID(ctx.traceId)`
alone. A span context pairing a valid trace ID with an all-zero span ID passed both guards, so
`spanID: '0000000000000000'` was stamped onto every log line and returned from
`getActiveTraceContext()`.

Low severity, fixed for symmetry rather than urgency: unreachable with a real OTel SDK, since
SDK-created spans always carry a well-formed span ID and OTel's `INVALID_SPAN_CONTEXT` zeroes the
trace ID too — which the old guard already caught. It bit only a hand-constructed or malformed
remote span context, and the W3C path rejects those at parse time.

## Design decisions (rationale preserved)

- **One internal predicate, not two inline checks.** `isValidSpanContext(ctx)` lives in
  `packages/otel/src/span-context.ts` beside the two ID predicates it composes, so the rule for
  "what makes a span context real" has one home. Both call sites keep their existing rejection
  behaviour — the bare logger, and `undefined`.
- **Deliberately not exported from `src/index.ts`.** The package's public surface is frozen; an
  exported predicate would be additive API that can never be removed, for a rule no consumer has
  asked for. A plan step verifies the negative, so a future change that leaks it into the barrel
  fails review rather than shipping.
- **`toRemoteSpanContext` keeps its own two-clause check.** It takes `TraceparentData`
  (`traceID`/`spanID`), not a `SpanContext` (`traceId`/`spanId`) — different shape, so sharing the
  predicate would cost a conversion worth more than the dedup saves.
- **`context.ts:injectW3CTraceContext` needs no guard.** It gates on `formatTraceparent`, which
  already validates both IDs.
- **`getActiveSpan` stays unvalidated, by design.** It returns the raw `Span` because callers need
  it for `setAttribute`/`end` even when non-recording. A consumer reaching through
  `getActiveSpan()?.spanContext()` still sees zero IDs; that asymmetry with `getActiveTraceContext`
  is intended, not an oversight.

## What was built

- `isValidSpanContext` added to `packages/otel/src/span-context.ts` with unit tests covering both
  clauses and a malformed span ID.
- Both call sites swapped to it, each with a test pairing a valid trace ID against an all-zero span
  ID, activated through the real context manager so the guard genuinely runs rather than the
  `span == null` early return.
- Changeset shipping `@sozai/otel` patch. No API added or removed; a bug fix narrowing an output
  path, and no consumer can depend on receiving an all-zero span ID.

## Verification

`@sozai/otel` 144 unit tests green, `tsc --noEmit` clean, biome clean.

The two new tests were mutation-verified rather than taken on trust: reverting either guard to its
trace-ID-only form fails exactly its own new test, and stripping the `isValidSpanID` clause from
the predicate fails 4. Pre-existing trace-ID tests stay green in all three runs — so neither new
test rides on the old clause.

Per-task reviews (3/3 code tasks) and a final whole-branch review returned no Critical or Important
findings. Two Minor findings were fixed in-branch: a test-header comment naming the superseded
guard, and a formatting fixup for the first commit.

## Follow-on

[log-sink forwards the active context unguarded](../backlog/2026-07-19-otel-log-sink-context-forwarding.md)
— found by the final review; pre-existing and out of scope here.
