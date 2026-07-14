---
'@sozai/otel': minor
'@sozai/log': minor
---

W3C Trace Context compliance.

**Breaking (`@sozai/otel`):**

- `injectTraceContext` and `extractTraceContext` are **removed**. The custom `tid`/`sid`
  header contract was a second, unvalidated encoding of the same three values the W3C
  path already carries: it skipped ID validation entirely and hardcoded
  `TraceFlags.SAMPLED`, so any string became a remote `SpanContext` and every remote
  trace was force-sampled. Use `injectW3CTraceContext` + the existing
  `extractW3CTraceContext`.
- **`injectW3CTraceContext<T extends Record<string, unknown>>(meta: T): T & { traceparent?: string; tracestate?: string }`**
  stamps `traceparent` (and `tracestate`, when the active span carries one) onto a meta
  record, and returns the record unchanged when there is no active span or the active
  span cannot produce a valid header.
- `formatTraceparent` now returns `string | undefined` — it returns `undefined` rather
  than emitting a structurally invalid header.
- `createTracerFactory(prefix, version?)` now takes the consuming package's version. It
  previously hardcoded a stale `@sozai/otel` version — which was also the wrong
  package's version to report as the instrumentation scope, since the tracer name
  identifies the consumer.

**Fixes (`@sozai/otel`):**

- All-zero trace IDs and span IDs are rejected on both parse and format. They previously
  became remote `SpanContext`s that SDKs parented real spans to.
- `parseTraceparent` rejects version `ff` and parses the first four fields of a higher
  version, per the spec's forward-compatibility rule.
- `formatTracestate` drops duplicate keys, matching `parseTracestate`.
- Successful spans are left `Unset` rather than set to `Ok`, per OTel guidance (both
  `withSpan` and `withSyncSpan`).
- The OTel log sink now renders interpolated values into the log body for
  tagged-template log calls. The sink carried a hand-copied `LogRecord` type that had
  drifted from logtape's: logtape's `rawMessage` for a tagged-template call
  (`` logger.info`hello ${name}!` ``) contains only the literal segments
  (`['hello ', '!']`), and logtape leaves `properties` empty for such calls, so the
  interpolated value lived only in `record.message`. The sink now renders the body from
  `record.message`, so `` logger.info`hello ${name}!` `` emits `'hello Alice!'`.
  Method-call syntax (`logger.info('Hello, {name}!', { name })`) is unchanged:
  placeholders stay in the body, values ride in `attributes`, which is idiomatic OTel.

**`@sozai/log`:** re-exports logtape's `LogRecord` type.
