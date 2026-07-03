# otel — W3C Trace Context compliance

**Status:** open · freeze-blocker · priority 8
**Source:** [audit 2026-07-02 — otel](../completed/2026-07-02-repo-audit.complete.md#otel)

The traceparent/tracestate handling violates W3C Trace Context in ways that produce invalid
remote SpanContexts and force-sampled traces. Batch the compliance fixes.

## Critical

- **`src/traceparent.ts:19-34` — all-zero trace-id / parent-id accepted.** W3C requires
  treating all-zero IDs as invalid; currently they become an invalid remote SpanContext that
  SDKs parent spans to.
- **`src/context.ts:43-48` — the tid/sid extraction path hardcodes `TraceFlags.SAMPLED` and
  skips ID validation** (the W3C path does both correctly); `injectTraceContext` sends no
  flags, so every remote trace is force-sampled and garbage IDs become SpanContexts. Inject
  and echo a flags field; validate 32/16 lowercase hex.

## Correctness

- `src/traceparent.ts:12-14` — `formatTraceparent` can emit invalid headers (`traceFlags`
  ≥ 256 or negative, unchecked ID lengths); mask with `& 0xff` at minimum.
- `src/traceparent.ts:26-28` — future traceparent versions rejected outright; spec says
  SHOULD parse the first four fields of higher versions.
- `src/tracestate.ts:27-41` — `formatTracestate` doesn't dedupe keys (parse does).

## Hygiene

- `src/tracers.ts:7` — `OTEL_PACKAGE_VERSION = '0.1.0'` hardcoded; will drift from the
  published version.
- `src/tracers.ts:61,86` — `setStatus(OK)` on every success; OTel guidance is to leave
  status UNSET for instrumentation.
- `src/log-sink.ts:4-11` — local `LogRecord` type duplicates logtape's; import it instead
  (drift risk — already needs both `warning` and `warn` mappings).

## Test-coverage gaps

All-zero IDs, flag overflow, tracestate duplicate keys.
