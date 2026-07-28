# @sozai/log

## 0.3.0

### Minor Changes

- 916f48c: `getDefaultConfig()` now carries a single root logger, so any category reaches the console at
  `error` unless an app deliberately narrows it. Previously its loggers covered `['logtape', 'meta']`
  and `['sozai']` only: an app calling `setup()` with no argument — the documented easy path —
  configured logging that dropped every other package's records. `isSetup()` answered true, so
  consumers' console fallbacks stayed out of the way, and the record went nowhere.

  The root entry **replaces** those two rather than joining them. `parentSinks` defaults to
  `'inherit'`, which unions a category's own sinks with its parent's without de-duplicating by sink
  identity, so keeping either beside a root entry naming the same sink would print every record under
  it twice. Behaviour for `['sozai']` and `['logtape', 'meta']` is unchanged: same level, same sink,
  once.

  **This is a behaviour change for every consumer of the default config, not only the one that
  found it.** Any dependency logging to logtape under any category now prints its errors. Bounded
  to `error` — `info` and `warn` under an unconfigured category are still dropped — and any app can
  narrow a category back with `parentSinks: 'override'`.

  New `getReporter(category, packageName)` returns an error reporter that always lands somewhere:
  the logger for `category` when logging is configured, a console line tagged with `packageName`
  when it is not. `error` level only, since `warn` is dropped by the default config. Consumers
  hand-rolling this pair of branches should adopt it.

## 0.2.0

### Minor Changes

- 9c0a867: W3C Trace Context compliance.

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
  - `formatTracestate` now also caps the _serialized header_ at 512 characters, dropping
    whole trailing members from the end rather than truncating mid-value (W3C §3.3.3 also
    requires removing oversized list-members first, largest first, before dropping from
    the end; we do not do that — this is drop-from-the-end only, safe and strictly better
    than the previous total-drop, but not full §3.3.3 conformance). This cap
    applies on both the read path (`extractW3CTraceContext`, via `parseTracestate`) and
    the write path (`injectW3CTraceContext`, which now re-runs the active span's
    `traceState.serialize()` through `parseTracestate`/`formatTracestate` before
    injecting). The write-side cap matters because OTel's `TraceStateImpl.set()` does
    _not_ enforce the 512-character limit — only `_parse()` does — so a `TraceState`
    extended via `.set()` calls (e.g. a vendor appending an entry to an inbound
    tracestate) can serialize past 512 characters even though it was under the cap on
    the way in. Previously that over-length header went out uncapped, and the _next_
    hop's `createTraceState` would bail out in `_parse` and drop the trace state
    entirely, silently losing it rather than truncating it.
  - `traceLogger` now uses the same `isValidTraceID` check as `getActiveTraceContext`,
    instead of a separate all-zero-ID comparison — removing the last place in the package
    that duplicated the trace-ID validation `src/span-context.ts` exists to centralize.
  - The OTel log sink's body renderer for tagged-template log calls is now total: it no
    longer throws on a `BigInt` or a circular value in an interpolated position (logtape
    catches sink exceptions and meta-logs them, so the process survived, but the log
    record was silently dropped). It now falls back to `String(part)` when
    `JSON.stringify` would throw or return `undefined` (which it does for a symbol,
    a function, or `undefined` in an interpolated position — those previously vanished
    from the body silently; they now render as `Symbol(x)`, the function source, and
    `'undefined'` respectively). If even `String(part)` throws (e.g. a null-prototype
    object), the renderer falls back to the literal placeholder `[unrenderable]`, which
    can therefore appear in production log bodies.
  - The OTel log sink now renders interpolated values into the log body for
    tagged-template log calls. The sink carried a hand-copied `LogRecord` type that had
    drifted from logtape's: logtape's `rawMessage` for a tagged-template call
    (`` logger.info`hello ${name}!` ``) contains only the literal segments
    (`['hello ', '!']`), and logtape leaves `properties` empty for such calls, so the
    interpolated value lived only in `record.message`. The sink now renders the body from
    `record.message`, so `` logger.info`hello ${name}!` `` emits `'hello Alice!'`.
    Method-call syntax (`logger.info('Hello, {name}!', { name })`) is unchanged:
    placeholders stay in the body, values ride in `attributes`, which is idiomatic OTel.
  - `isValidTraceID` and `isValidSpanID` are now exported from the package root, alongside
    `ZERO_TRACE_ID`, so consumers needing to validate an ID no longer have to re-implement
    the all-zero check by hand. `ZERO_SPAN_ID` and `toRemoteSpanContext` remain internal.

  **`@sozai/log`:** re-exports logtape's `LogRecord` type.

## 0.1.1

### Patch Changes

- 6212734: `setup()` no longer throws when logging is already configured.

  Previously `setup()` called logtape's `configureSync` unguarded, which throws `ConfigError` on a second call — two independent consumers each calling `setup()` crashed the process. The first call now wins: a later call logs an `error` record on the `['sozai', 'log']` logger (reaching whatever sinks the first caller installed) and returns without reconfiguring.

  Also adds `reset()`, which wraps logtape's `resetSync()`. It is the escape hatch for deliberate reconfiguration — `reset()` then `setup(config)` — and the way test suites clear logtape's process-global state between cases.

  Also adds `isSetup()`, which reports whether logging has been configured, so a consumer can check whether its `setup()` call won without importing `getConfig` from `@logtape/logtape` directly.

  This is the package's first release with tests.
