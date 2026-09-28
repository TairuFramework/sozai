# flow-graph -- JSON-serialisable flow graphs on top of @sozai/flow

**Status:** complete (v1 scope; flow references deferred as planned)
**Date:** 2026-09-28
**Packages:** `@sozai/flow-graph` (new -- 0.1.0), `@sozai/json` (minor intent, from 0.1.1)
**Prerequisite:** [async retry](./2026-09-28-async-retry.complete.md)
**Requested by:** mokei, for `@mokei/decision-flow` (now unblocked)

## Why

`@sozai/flow` runs a state machine whose definition is code, so it cannot be persisted, inspected,
visualised or written by an LLM. Mokei needs multi-decision flows whose full definition is JSON,
authored by developers and by LLMs, with runs that resume from JSON state in another process. The
engine is not specific to System One, so it lives in sozai. Mokei adds its `decide` kind through
the node kind extension point.

## Key design decisions

**Everything is a JSON value.** Definitions, run input, writes, results, resumed values and
`RunState` are validated as finite JSON values, so `JSON.parse(JSON.stringify(runState))` always
round-trips. `ref` values are copied on read, so a live run and a resumed run behave the same.
The generic parts moved to `@sozai/json`: `JSONValue`, a strict `isJSONValue` (no accessors,
holes, symbol keys, class instances or cycles) and `canonicalizeJSON`, which always returns a
string.

**Definitions are pinned by digest.** Each frame records the flow `id`, `version` and a SHA-256
digest of the canonical JSON definition. `resume` rejects a mismatch, so an edit that forgot to
bump `version` cannot silently run.

**One extension point for built-ins and consumers.** A `NodeKind` declares its schema, outgoing
edges, optional `resultSchema`, retry support, `describeError`, `check`, `execute` and `resume`.
Built-ins: `branch`, `set`, `loop`, `action`, `input`, `end`. Kinds see the current attempt's
staged writes. A failed attempt discards them, so a retry starts from committed state.

**Step commits make crashes recoverable.** Every node transition commits atomically, and
`FlowRun.next()` yields each commit (entry, attempt checkpoint, replay checkpoint, retry or terminal
failure, transition, suspend) for the host to persist. A failure commit always carries its
disposition, so `recover` can tell the next phase from the state alone. Execution is at least once.
`invocationID` stays stable across attempts and crash replays of one node entry, for idempotent
side effects. Interruptions do not consume `maxAttempts`, but `maxInterruptions` bounds crash
loops. Hosts must persist with optimistic concurrency on `revision`, because the engine takes no
lease.

**Retry state is a snapshot.** The effective policy and the absolute deadline are stored on node
entry, and `retryAt` is committed once. Changed code defaults, jitter and `Retry-After` are never
recomputed after a crash. Waits longer than `suspendAfterMs` suspend the run instead of sleeping.
`recover` ends an in-flight attempt whose deadline has passed instead of replaying it.

**Attempt timeouts stay inside handlers.** The only step signal given to `@sozai/flow` is the run
abort signal, because `@sozai/flow` discards a handler result when its step signal aborts. Timeouts
and deadlines run through `raceAttempt`. Non-retrying kinds receive the live run signal. No change
to `@sozai/flow` was needed.

**The checker targets LLM repair.** `check` returns issues with a definition path and a fix hint.
Schema failures are reported per field. Rules cover unknown kinds and targets, unreachable nodes,
cycles that do not pass through a loop body edge (including cycles only reachable inside a body),
nodes that cannot reach an `end`, invalid scope and result paths, the handled-error shape,
reads the producer may not dominate, unknown actions, uncompilable nested schemas and invalid
retry policies. Only filter leaves and `set` targets are checked as scope paths. All lookups of
user keys are own-property lookups, so names like `toString` are rejected.

**Privacy by default.** Spans are started directly rather than through `withSpan`, so no payload,
error message or exception is recorded unless `recordErrorMessages` is set. Kinds do not log. The
engine emits one record per event with message-free `ErrorMetadata`, and run errors fall back to
`console.error` when logging is not set up. Resume and recover segments link to the origin trace
instead of using it as parent.

## What was built

`@sozai/flow-graph` 0.1.0: `createFlowGraph` with `check`, `start`, `resume`, `recover` and `run`,
the authoring schema (for LLMs), the storage schema (accepting reserved `call`, `goto` and
`loop.body: { flow }` shapes), `runStateSchema` and status-matrix invariants, the filter evaluator,
`defineNodeKind`, `FlowRetryableError`, `toTimestamp`, `formatIssues` and `digestDefinition`.
Dependencies: `@sozai/flow`, `schema`, `event`, `async`, `otel`, `log`, `runtime`, `json`, and
`@noble/hashes` (added to the catalog).

199 tests in `@sozai/flow-graph`, 60 in `@sozai/json`.

## Deviations from the spec

- The tracer has no version: it is `createTracerFactory('sozai')('flow-graph')`, like the other
  stack tracers. Importing `package.json` with a JSON import attribute broke the built output,
  because swc drops the attribute.
- `isJSONValue` accepts `-0`, which becomes `0` after a JSON round trip. The digest is unaffected.
- A custom kind's `resultSchema(node)` needs a real node, so it is validated by the checker, not
  entirely at registration.

## Follow-on

- [flow-graph -- flow references](../backlog/2026-09-28-flow-graph-flow-references.md)
