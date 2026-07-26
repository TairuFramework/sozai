---
name: observability
description: Use when adding structured logging or OpenTelemetry tracing to sozai code.
---

# Sozai observability

Structured logging and tracing. A LogTape-backed namespaced logger, and OpenTelemetry tracing
with W3C context propagation and baggage.

## Packages

- **@sozai/log** — structured logging via [LogTape](https://logtape.org): `setup`, `getLogger`,
  console sink. → `reference/log.md`
- **@sozai/otel** — tracer and spans, semantic constants, ID validation. → `reference/otel.md`
  - W3C context propagation and baggage. → `reference/otel-propagation.md`
  - Bridges log records to the active span, via `createOTelLogSink` and `traceLogger`. →
    `reference/otel-log-bridge.md`

## Pick this when

- Doing structured application or library logging — call `setup` once at the process entry point,
  then `getLogger`/`getSozaiLogger` everywhere else → `reference/log.md`
- Instrumenting an operation for distributed tracing — `createTracerFactory` +
  `withSpan`/`withSyncSpan` → `reference/otel.md`
- Propagating W3C `traceparent`/`tracestate` across a request boundary —
  `injectW3CTraceContext` + `extractW3CTraceContext` → `reference/otel-propagation.md`
- Correlating log records with traces in your OTel backend — add `createOTelLogSink()` as a
  LogTape sink at startup and wrap per-request loggers with `traceLogger` →
  `reference/otel-log-bridge.md`

## Related

`@sozai/otel` depends on `@sozai/log`; both live in this domain.
