# otel — W3C Trace Context compliance

**Status:** complete
**Date:** 2026-07-14
**Branch:** `otel-w3c-compliance` (16 commits, `d22f876..07d6663`)
**Packages:** `@sozai/otel` (minor), `@sozai/log` (minor)
**Source:** [audit 2026-07-02 — otel](2026-07-02-repo-audit.complete.md#otel) · freeze-blocker, priority 8

## Goal

The traceparent/tracestate handling violated W3C Trace Context in ways that produced invalid remote
`SpanContext`s and force-sampled traces. Batch the compliance fixes, plus three hygiene defects the
same audit found.

## The central design decision

The audit asked to *patch* the custom `tid`/`sid` propagation path — add a flags field, validate the
IDs. We **deleted it instead**.

That path was a second, unvalidated encoding of the same three values (trace ID, span ID, flags) the
W3C `traceparent` path already carried. It skipped ID validation entirely and hardcoded
`TraceFlags.SAMPLED`, so any string became a remote `SpanContext` that SDKs parented real spans to,
and every remote trace was force-sampled. A search across all sibling repos found
`injectTraceContext`/`extractTraceContext` referenced only in documentation — no source consumer
anywhere in the stack. The format was unshipped, so it could be removed rather than repaired.

Patching it would have left two formats and two places for the next bug to land. Deleting it removed
the bug class instead of an instance of it.

**The resulting invariant, which the whole refactor exists to protect:** `src/span-context.ts` is the
single authority for trace-ID/span-ID validation, and `toRemoteSpanContext` is the only place in the
package that constructs a remote `SpanContext`. The final review verified this by grep: every
hex/length/all-zero check lives in that one module, and `isRemote` appears exactly once in the
package. Any future change that adds a validation check elsewhere is regressing this.

## What shipped

**Breaking (`@sozai/otel`):**
- `injectTraceContext` / `extractTraceContext` removed. Replaced by `injectW3CTraceContext`, the
  inject-side twin of the existing `extractW3CTraceContext`.
- `injectW3CTraceContext<T>(meta: T): T & { traceparent?: string; tracestate?: string }` — the
  intersection return type is deliberate. A bare `: T` widens away the very fields the function adds,
  so no caller can read back what it just stamped.
- `formatTraceparent` returns `string | undefined` rather than emitting a structurally invalid header.
  Out-of-range flags are **rejected, not masked** — the audit suggested `& 0xff`, but that turns `256`
  into `00` and silently flips a sampled trace to unsampled.
- `createTracerFactory(prefix, version?)` takes the *consuming* package's version. The old hardcoded
  `OTEL_PACKAGE_VERSION = '0.1.0'` was not merely stale but semantically wrong: the tracer name
  identifies the consumer, and OTel's instrumentation-scope version means the version of the
  instrumentation library — the consumer's, not ours.
- `isValidTraceID` / `isValidSpanID` now exported, so consumers reach for the right tool instead of
  re-implementing an all-zero check against the raw `ZERO_TRACE_ID` constant.

**Compliance fixes:**
- All-zero trace and span IDs rejected on both parse and format (W3C declares them invalid).
- `parseTraceparent` rejects version `ff`; parses the first four fields of a higher version and
  ignores trailing content, per the spec's forward-compatibility rule. Version `00` must carry
  exactly four fields.
- `formatTracestate` drops duplicate keys (matching `parseTracestate`), and dedupes *before* applying
  the 32-entry cap so duplicates cannot consume cap budget.
- Tracestate is truncated to 512 characters by dropping whole members from the end, on **both** the
  extract and inject paths. Previously an over-512 header was dropped *entirely* — OTel's
  `TraceStateImpl._parse` returns early past `MAX_TRACE_STATE_LEN`, leaving an empty map.
- Successful spans are left `Unset` rather than set to `Ok`, per OTel guidance (both `withSpan` and
  `withSyncSpan`). OTel reserves `Ok` for an explicit application override.

**Log sink:**
- Dropped a hand-copied `LogRecord` type that had drifted from logtape's; `@sozai/log` now re-exports
  the real one. The severity map became an exhaustive `Record<LogLevel, SeverityNumber>`, which
  deleted a dead `warn` key (logtape's level is `warning`) and an `?? 9` fallback.
- The body renderer is now **total**: it never throws and never silently drops a value. Interpolated
  values in tagged-template log calls now reach the body.

## Bugs found that the audit missed

Three defects surfaced during implementation and review that were not in the original audit:

1. **The log sink silently dropped records.** `JSON.stringify` throws on `BigInt` and on circular
   structures, and logtape catches sink exceptions and meta-logs — so `` logger.info`req ${req}` ``
   with any back-referencing object (a request, a socket, a linked node) lost the record entirely.
   The renderer is now total, verified against 28 adversarial inputs (Proxy traps, revoked proxies,
   throwing `toString`/`toJSON`/`Symbol.toPrimitive`, null-prototype circulars, 200k-deep nesting).
2. **Tracestate over 512 chars was dropped rather than truncated** — and after the first fix, still
   was, on the *write* path. `TraceStateImpl.set()` does not enforce the length limit (only `_parse`
   does), so a vendor `set()` on a near-limit inbound tracestate produced an over-length header that
   the *next* hop dropped in full.
3. **`src/logger.ts` retained its own `=== ZERO_TRACE_ID` check**, so `traceLogger` and
   `getActiveTraceContext` disagreed on what a valid trace ID was — falsifying the branch's central
   invariant. No task's brief covered that file, so no per-task review could see it; only the
   whole-branch review caught it.

## The testing hazard worth remembering

**`@opentelemetry/api`'s default `NoopContextManager` discards the context passed to
`context.with()`** — `context.active()` always returns `ROOT_CONTEXT`. Any test that "activates" a
span without registering a real context manager is asserting against a code path that never ran.

This produced **four separate tests on this branch that passed for the wrong reason**, including —
on the second-to-last review round — the tests written specifically to fix the previous vacuous test.
A second variant of the same trap: mocking a logger as `{ with: () => mockLogger }` makes the guarded
path (returns `logger`) and the unguarded path (returns `logger.with(...)`) indistinguishable, so
`toBe(mockLogger)` cannot discriminate between them.

Defenses now in place, worth preserving:
- `packages/otel/test/helpers/context-manager.ts` provides `useTestContextManager()`, an
  `AsyncLocalStorage`-backed manager with teardown. It **throws** if `setGlobalContextManager()`
  refuses the registration — that call returns `false` on a duplicate and its failure path is a
  silent no-op, so discarding the result would let every activation-dependent test quietly revert to
  vacuous.
- Every guard in the package is mutation-tested: delete the guard, confirm the test goes red.

The general lesson: for any test protecting a guard, the question is not "does it pass" but "does it
fail when I delete the thing it protects." On this branch that question had a different answer than
expected four times.

## Verification

138/138 `@sozai/otel`, 18/18 `@sozai/log`, typecheck and biome clean. Seven tasks, each independently
reviewed; three whole-branch adversarial review rounds, each of which found real defects the previous
round's fixes had left.

## Follow-on

- [otel-span-id-validation-gap](../backlog/otel-span-id-validation-gap.md) — `traceLogger` and
  `getActiveTraceContext` validate the trace ID but not the span ID. Pre-existing, consistent across
  both sites, unreachable with a real SDK. Deliberately out of scope here.

Also noted during the docs sweep and left alone as pre-existing: `docs/reference/observability.md`
documented a `SpanNames` const that does not exist (removed), and `docs/skills/observability.skill.md`
referenced a `createTracer` export that never existed (fixed to `createTracerFactory`).
