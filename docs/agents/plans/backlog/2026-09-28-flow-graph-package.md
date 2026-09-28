# flow-graph — JSON-serialisable flow graphs on top of @sozai/flow

**Status:** open · requested by mokei (blocks `@mokei/decision-flow`)
**Package:** `@sozai/flow-graph` (new)
**Prerequisite:** `2026-09-28-async-retry.md` (`@sozai/async` retry policy and helpers)
**Consumer design:** `../mokei/docs/superpowers/specs/2026-09-28-decision-flow-design.md`

## Why

`@sozai/flow` runs a state machine whose definition is code: a record of handler functions, each
hard-coding the next action. That cannot be persisted, inspected, visualised or written by an LLM.
Mokei needs multi-decision flows (System One classification driving branches and loops) whose
**full definition is JSON**, authored both by developers and by LLMs, and whose **runs are
resumable** from JSON state in another process.

The engine is not System One specific, so it belongs in sozai. Mokei adds a `decide` node kind
through the extension point below.

## Scope (v1)

- JSON flow definition types, an authoring schema and a storage schema.
- Filter language and evaluator.
- Built-in node kinds: `branch`, `set`, `loop`, `action`, `input`, `end`.
- Node kind extension point (execute, resume, retry classification, result schema), used by the
  built-ins and by consumers.
- Per-node retry policy with timeouts and backoff.
- Static checker with LLM-repairable issues.
- Resumable runtime driving `@sozai/flow`, plus a run-to-completion wrapper.
- Tracing via `@sozai/otel`, error logging via `@sozai/log`, IDs via `@sozai/runtime`, definition
  digest via `@noble/hashes`.

Designed now, implemented in a follow-on (the storage schema and run state already accommodate
them): flow references (`call`, `goto`, `loop.body: { flow }`) and a `FlowResolver`.

Out of scope: parallel branches, LLM generation nodes (a host wraps them as actions or extension
kinds), metrics API.

## JSON values

```ts
type JsonValue = null | boolean | number | string | Array<JsonValue> | { [key: string]: JsonValue }
```

Everything entering a definition or a `RunState` must be a `JsonValue`: run input, `set` values,
action and kind results, resumed values, suspend prompts and data, `end` output. Numbers must be
finite. Validation points:

- **Definition:** `check`, `start` and `resume` first validate the whole definition as a finite
  `JsonValue` (before hashing it), then against the schema. Nested JSON Schemas (`input`,
  `input.schema` on nodes, kind-specific schemas) are compiled with `@sozai/schema` at check time;
  a schema that fails to compile is issue `invalid_schema`.
- **Run input:** validated as `JsonValue` and against `definition.input` before the first frame is
  built (`FlowInputError`).
- **Writes:** each staged write (see *Step commit*) is validated; failure fails the node with code
  `invalid_value`.
- **Resume:** the full `RunState` (see *Runtime API*).

This is what makes the `JSON.parse(JSON.stringify(runState))` round-trip guarantee hold.

## Definition format

```ts
type FlowDefinition = {
  id: string            // unique, host-chosen, e.g. "support/triage"
  name: string
  version: number       // integer, bumped on every edit
  description?: string
  input?: Schema        // JSON Schema for the run input
  start: string         // node id
  nodes: Record<string, Node>
}

type Path = Array<string>             // first segment is a scope root

type Value =
  | { ref: Path }                     // missing path resolves to null
  | { value: JsonValue }              // literal, taken as-is (no refs inside)
  | { object: Record<string, Value> } // build an object whose fields may be refs
  | { array: Array<Value> }           // build an array whose items may be refs
```

The four tags keep literal-versus-ref explicit while allowing nested payloads without extra `set`
nodes.

Path segments `__proto__`, `constructor` and `prototype` are rejected by the schema everywhere.
The list is exported as `UNSAFE_PATH_SEGMENTS` (with `isSafePathSegment(key)`) so kinds can reject
keys that would later need to appear in a path.

### Filters

```ts
type Filter =
  | { path: Path; is: ValueFilter }   // every operator in `is` must hold (AND)
  | { and: Array<Filter> }            // minItems 1
  | { or: Array<Filter> }             // minItems 1
  | { not: Filter }

type ValueFilter = {                  // minProperties 1
  isNull?: boolean
  equalTo?: JsonValue                 // non-null; use isNull for null
  notEqualTo?: JsonValue              // non-null
  in?: Array<JsonValue>               // minItems 1
  notIn?: Array<JsonValue>            // minItems 1
  lessThan?: number | string
  lessThanOrEqualTo?: number | string
  greaterThan?: number | string
  greaterThanOrEqualTo?: number | string
  contains?: string
  includesAll?: Array<string | number>  // minItems 1
  includesAny?: Array<string | number>  // minItems 1
  presence?: 'null' | 'nonNull' | 'empty' | 'nonEmpty' | 'nullOrEmpty'
}
```

Operator names are inspired by kubun's document filters (`kubun/packages/protocol/src/types.ts`),
but the leaf is flat (`{ path, is }`) rather than kubun's nested `where` object: one way to write a
condition is easier for LLMs to produce and for the checker to validate. No kubun dependency.

Truth table (subject = the value at `path`; a missing path is `null`):

| Operator | True when |
|---|---|
| `isNull: true` / `false` | subject is / is not `null` |
| any other operator, subject `null` | never (except `presence`) |
| `equalTo` / `notEqualTo` | deep structural equality: arrays order-sensitive, objects same key set and equal values |
| `in` / `notIn` | some / no operand deep-equals the subject |
| ordering operators | subject and operand both numbers (numeric) or both strings (UTF-16 code-unit order); mixed types: false |
| `contains` | subject is a string containing the operand; non-string subject: false |
| `includesAll` / `includesAny` | subject is an array containing all / any operands (deep equality); non-array: false |
| `presence: 'null'` / `'nonNull'` | subject is / is not `null` |
| `presence: 'empty'` / `'nonEmpty'` | subject is / is not `[]` or `""`; other types: `nonEmpty` true |
| `presence: 'nullOrEmpty'` | `null`, `[]` or `""` |

Filter evaluation never throws.

### Scope roots

Refs, filters and `set` targets resolve against the current frame:

| Root | Content | Writable |
|---|---|---|
| `input` | run input | no |
| `state` | mutable flow state | via `set` only |
| `results` | per-node output, `results.<nodeId>` | by the engine only |
| `loops` | loop counters, `loops.<nodeId>` | no |

### Built-in node kinds

| Kind | Shape | Behaviour |
|---|---|---|
| `branch` | `{ cases: [{ when: Filter, to }], default }` | first matching case wins |
| `set` | `{ assign: [{ path, value: Value }], next }` | applied in order, each seeing earlier writes; paths start with `state`; intermediate objects created |
| `loop` | `{ maxIterations, while: Filter, body, exit, onExhausted? }` | see below |
| `action` | `{ name, args?: Record<string, Value>, next, onError?, retry? }` | calls host action; result to `results.<id>` |
| `input` | `{ prompt?: Value, schema?, next, timeout?: { afterMs, to } }` | suspends; resumed value validated, to `results.<id>` |
| `end` | `{ outcome?, output?: Record<string, Value> }` | terminal (or returns to caller, follow-on) |

Every node also takes optional `description` (for humans, LLMs and visualisation).

**Loop semantics.** On entry: if `while` is false, reset `loops.<id>` and go to `exit`. If true and
`loops.<id> < maxIterations`, increment and go to `body`. If the limit is reached, reset the counter
and go to `onExhausted`, or end the run with error code `loop_exhausted`. The body path returns to
the loop node through a back-edge. In the follow-on, `body` may also be `{ flow, version? }`.

**Reserved kinds** (storage schema only; see *Schemas*):

- `call`: `{ flow, version?, input?: Record<string, Value>, next, onError?, retry? }`
- `goto`: `{ flow, version?, input?: Record<string, Value> }`

## Node kind extension point

Built-ins and consumer kinds use the same API:

```ts
type NodeKind<N extends { kind: string }> = {
  kind: N['kind']
  schema: Schema                          // node schema, `kind` as a const
  targets: (node: N) => Array<{ path: Array<string | number>; id: string }>  // outgoing edges
  resultSchema?: (node: N) => Schema      // shape of results.<id>, for cross-node path checks
  retries?: boolean                       // node may carry `retry`; default false
  describeError?: (error: unknown) => ErrorMetadata   // safe fields for logs, spans and lastFailure
  check?: (node: N, ctx: CheckContext) => Array<FlowIssue>
  execute: (node: N, ctx: ExecuteContext) => NodeResult | Promise<NodeResult>
  resume?: (node: N, ctx: ExecuteContext, event: ResumeEvent) => NodeResult | Promise<NodeResult>
  retryable?: (error: unknown) => RetryDecision   // from @sozai/async; default: never retry
}

type NodeResult =
  | { next: string; result?: JsonValue }
  | { end: { outcome?: string; output?: Record<string, JsonValue> } }
  | { suspend: { prompt?: JsonValue; schema?: Schema; data?: JsonValue; deadline?: string } }

/** Message-free error description. Kinds must never put user or backend text here. */
type ErrorMetadata = { type: string; code?: string; status?: number; retryAfterMs?: number }
// default when a kind has no describeError: { type: error.name } (or 'Error' for non-errors)
// The engine sanitises every describeError result before use: drops fields of the wrong type,
// drops non-finite numbers and clamps retryAfterMs to [0, MAX_DELAY_MS], so lastFailure stays JSON.
// A missing or non-string `type` is replaced by the default above, never dropped.

type ResumeEvent =
  | { type: 'value'; value: JsonValue }   // external result delivered by the host
  | { type: 'timeout' }                   // host resumes at or after pending.deadline

type ExecuteContext = {
  nodeID: string
  runID: string
  invocationID: string                    // fixed at node entry, see Delivery guarantee
  attempt: number                         // 1-based
  pending?: { data?: JsonValue }          // this node's suspend data, on resume
  scope: Readonly<Scope>                  // committed scope plus this attempt's staged writes
  resolve: (value: Value) => JsonValue    // reads staged writes
  evaluate: (filter: Filter) => boolean   // reads staged writes
  setResult: (value: JsonValue) => void   // staged; replaces any earlier staged result
  signal: AbortSignal                     // run abort + attempt timeout + total deadline
  span: Span                              // active flow.node span, for kind attributes
  logger: Logger
  runtime: Runtime
}
```

`defineNodeKind(kind)` is an identity helper for inference.

Rules:

- Only kinds defining `resume` may return `suspend`. The checker flags unknown kinds; the runtime
  fails the node with `invalid_suspend` if a kind without `resume` suspends.
- `next` returned by `execute` or `resume` must be one of `targets(node)`; otherwise the node fails
  with `invalid_target`.
- `suspend.data` is the kind's continuation (e.g. an external job ID); it comes back in
  `ctx.pending.data`. `deadline` (canonical UTC timestamp) tells the host when to send a `timeout`
  event.
- Mokei's `decide` kind calls `setResult(answers)` then evaluates its own `cases`, which is why
  `setResult` and `evaluate` are exposed. `resolve`, `evaluate` and `scope` see the current attempt's
  staged writes as an overlay; the overlay is discarded when the attempt fails, so a retry starts
  from committed state.

## Retry policy

```ts
type FlowRetryPolicy = RetryPolicy & {   // RetryPolicy from @sozai/async
  suspendAfterMs?: number                // waits longer than this suspend the run instead of sleeping
  maxInterruptions?: number              // crash replays of one attempt; integer 0-100, default 3
}
```

- Declared per node as `retry` in JSON, on kinds with `retries: true` (built-in: `action`; the
  follow-on `call`). The schema rejects `retry` elsewhere.
- Graph-level defaults per kind in code: `retryDefaults: { action: {...}, decide: {...} }`. A node's
  `retry` replaces the default (no field merge).
- On a thrown error the engine asks `kind.retryable(error)`. `action` retries only
  `FlowRetryableError` (exported, with optional `afterMs`) and attempt timeouts. An attempt timeout
  (`TimeoutInterruption`) is retryable for every kind with `retries: true`.
- Bounds: `RetryPolicy` bounds from `@sozai/async` (`assertRetryPolicy`), enforced by the schema;
  `suspendAfterMs` uses the same millisecond bounds.
- **Policy snapshot.** On node entry the engine resolves the effective policy (node `retry`, else
  `retryDefaults[kind]`, else `{ maxAttempts: 1 }`) and stores it in `attempts[nodeID].policy`. Every
  later attempt, in any process, uses the snapshot, so changed code defaults cannot alter a node
  already in progress.
- **Total deadline.** On node entry, when `totalTimeoutMs` is set, the engine stores the absolute
  `attempts[nodeID].deadline` (canonical UTC timestamp, see *Time*). Each attempt runs through
  `raceAttempt` from `@sozai/async` with `attemptTimeoutMs`, the deadline and the graph's `now`.
- **Attempt execution never uses the `@sozai/flow` step signal.** The step signal passed to
  `@sozai/flow` is the run abort signal only, because `@sozai/flow` discards a handler's result when
  its step signal aborts. Attempt timeouts and the deadline are enforced inside the handler by
  `raceAttempt`, which also rejects for handlers ignoring their signal; a late completion of an
  abandoned attempt is ignored.
- Wait = `getRetryDelay(policy, attempt, { afterMs, random })`, where `afterMs` comes from
  `retryable` or `describeError(error).retryAfterMs`.
- **The disposition is decided once and committed with the failure** (see *Step commit*): either
  *retry* with an absolute `attempts[nodeID].retryAt = now() + wait`, or *terminal*. Jitter and
  `Retry-After` are therefore never recomputed after a crash.
- A wait whose `retryAt` would be past the deadline is not scheduled: the disposition is terminal
  (`total_timeout`).
- Wait ≤ `suspendAfterMs` (or no `suspendAfterMs`): the run stays `running` with `retryAt` set;
  abortable in-process sleep until `retryAt`, then the next attempt in the same segment.
- Wait > `suspendAfterMs`: the run suspends with `pending.reason: 'retry'` and
  `resumeAt = retryAt`, and the host resumes with `{ type: 'retry' }` at or after `resumeAt`. An
  early `retry` event is rejected with `FlowResumeError`; state untouched. A `retry` event arriving
  after the deadline is accepted and exhausts the node immediately, without another attempt.
- **Last failure.** Each failed attempt stores `attempts[nodeID].lastFailure`
  (`ErrorMetadata`, from `describeError`, no message), so the terminal error and `onError` result
  carry it even after a suspension.
- Terminal (`attempts` exhausted, `total_timeout`, `non_retryable`, `interrupted`): `onError` if
  set, else run `error` with code `node_failed`, `reason`, `attempts` and the last failure in
  `RunState.error`.
- **Interruptions** (crash mid-attempt) do not consume `maxAttempts`; see *Delivery guarantee*.
- `attempts[nodeID]` is cleared when the node completes. See *Step commit* for durability.

## Schemas

Two exported schemas, both composed at runtime from the registered kinds:

- **Authoring schema** (`graph.authoringSchema`): only kinds executable in this version. This is the
  one to hand an LLM; anything valid against it can run once it passes the checker. Every field
  carries a `description`, and examples are included.
- **Storage schema** (`graph.storageSchema`): adds reserved shapes (`call`, `goto`, `loop.body`
  objects) so stored definitions written for a later version still parse.

## Static checker

`graph.check(definition)` returns `{ ok, issues }`, with
`FlowIssue = { severity: 'error' | 'warning', path: Array<string | number>, code, message, hint }`.
`path` points into the definition; `hint` says how to fix it, so an LLM can repair the flow.

Rules:

- `schema` — authoring schema, via `@sozai/schema`. Reserved shapes that pass the storage schema
  get code `unsupported` instead of a generic schema error.
- `unknown_kind` — node kind not registered.
- `unknown_target` — `start` and every edge from `targets()` name an existing node.
- `unreachable` (warning) — node not reachable from `start`.
- `unbounded_cycle` — every cycle must traverse the `body` edge of some `loop` node. Cycles through
  `exit` or `onExhausted` alone are rejected, since they reset the counter. `maxSteps` remains a
  runtime backstop.
- `no_end` — every node can reach an `end` node.
- `invalid_path` — root is `input|state|results|loops`; `results.<id>` names an existing node;
  `loops.<id>` names a `loop` node; `set` writes only under `state`; no unsafe segments.
- `invalid_result_path` — when the producing kind has `resultSchema`, the rest of a `results.<id>`
  path must exist in that schema. Applies across nodes, not only within the producer. A
  `resultSchema` is a **static, closed** description (`additionalProperties: false` wherever paths
  are checkable): it lists what flows may reference, not everything a result may contain at
  runtime. Extra runtime fields are kept but cannot be referenced. An open object (`additionalProperties`
  schema) makes any key below it referenceable.
- `invalid_error_path` — `results.<id>.error` is checked independently of the kind's
  `resultSchema`. When `<id>` has `onError`, the rest of the path must exist in the fixed
  handled-error shape (`error.type`, `error.code`, `error.status`, `error.reason`,
  `error.attempts`; see *Errors*), whatever the kind, with or without `resultSchema`. When `<id>`
  has no `onError`, `error` is an ordinary result key: checked against `resultSchema` if the kind
  has one, unchecked otherwise. A kind's `resultSchema` must not declare a top-level `error`
  property; `createFlowGraph` rejects such a kind at registration (`FlowDefinitionError` is not
  involved: this is a programming error, thrown as `TypeError`).
- `result_maybe_missing` (warning) — a `results.<id>` read at a node that `id` does not dominate
  (the producer may not have run on every path there). The read yields `null`.
- `unknown_action` — `action.name` not in the registry, when the graph has one.
- `invalid_schema` — a nested JSON Schema fails to compile.
- `invalid_retry` — `retry` on a kind without `retries`, a policy outside the `@sozai/async` bounds,
  or `suspendAfterMs` ≥ `totalTimeoutMs`.
- Kind `check` hooks add their own issues.

`formatIssues(issues)` renders compact text for model repair loops.

## Run state

```ts
type Frame = {
  flow: { id: string; version: number; digest: string }
  node: string
  input: JsonValue
  state: Record<string, JsonValue>
  results: Record<string, JsonValue>
  loops: Record<string, number>
  invocation: number                      // incremented on each node entry in this frame
  attempts: Record<string, NodeAttempts>  // only for the node in progress
  continuation?: {                        // follow-on: set on a pushed frame
    kind: 'call' | 'loopBody'
    callerNode: string                    // node in the frame below that receives the result
    returnTo: string                      // caller node to continue at
    onError?: string
  }
}

type NodeAttempts = {
  invocationID: string                    // `${runID}:${frameIndex}:${invocation}`
  policy: FlowRetryPolicy                 // snapshot taken on node entry
  count: number                           // logical attempts started (against maxAttempts)
  interruptions: number                   // crash replays of the current attempt (against maxInterruptions)
  deadline?: string                       // absolute total deadline (UTC timestamp)
  retryAt?: string                        // committed retry disposition (UTC timestamp)
  lastFailure?: ErrorMetadata
}

type RunState = {
  runID: string
  revision: number                        // incremented on every commit (see Step commit)
  status: 'running' | 'suspended' | 'ended' | 'error' | 'aborted'
  frames: Array<Frame>                    // v1: always length 1
  steps: number                           // node entries, counted against maxSteps
  inFlight?: { node: string; attempt: number; invocationID: string }  // attempt checkpoint
  origin?: { traceparent: string }
  pending?: {
    node: string
    reason: 'suspend' | 'retry'
    prompt?: JsonValue
    schema?: Schema
    data?: JsonValue
    deadline?: string                     // suspend: send `timeout` at or after
    resumeAt?: string                     // retry: send `retry` at or after
  }
  outcome?: string
  output?: Record<string, JsonValue>
  error?: {
    code: string
    name: string
    node?: string
    reason?: 'attempts' | 'total_timeout' | 'non_retryable' | 'interrupted'
    attempts?: number
    lastFailure?: ErrorMetadata
  }
}
```

- **Digest.** `sha256` from `@noble/hashes` over canonical JSON of the definition (object keys
  sorted recursively, no whitespace), hex-encoded. Recorded per frame; `resume` rejects a definition
  whose `id`, `version` or `digest` differs (`FlowVersionMismatchError`), so an edit that forgot to
  bump `version` cannot silently run.
- **Validation.** `start` validates `input` (see *JSON values*). `resume` and `recover` validate the
  definition (JSON, schema, then digest), then `runState` against the exported `runStateSchema`,
  then against the invariants below (`FlowStateError`), before anything else. None mutates state
  on failure.
- **Invariants checked on resume and recover.** Status matrix:

  | `status` | `pending` | `inFlight` | `attempts[top.node].retryAt` | `outcome` / `output` / `error` |
  |---|---|---|---|---|
  | `running` | absent | optional | optional, never with `inFlight` | absent |
  | `suspended` | required | absent | present iff `pending.reason: 'retry'`, equal to `pending.resumeAt` | absent |
  | `ended` | absent | absent | absent | `error` absent |
  | `error` | absent | absent | absent | `error` required |
  | `aborted` | absent | absent | absent | `error` absent |

  Plus: the top frame's `node` exists in the definition; `pending.node === top.node`; `attempts`
  holds at most the entry for `top.node`, only for a kind with `retries`; `1 ≤ count ≤
  policy.maxAttempts` once an attempt started; `interruptions ≤ policy.maxInterruptions`;
  `inFlight.node === top.node`, `inFlight.attempt === count ≥ 1`,
  `inFlight.invocationID === attempts[top.node].invocationID`; every timestamp is a canonical UTC
  timestamp (see *Time*); every `loops` key names a `loop` node with a counter within
  `maxIterations`. `resume` additionally requires `suspended`; `recover` requires `running`.
- **Errors carry no messages.** `RunState.error` holds class name, code and status only (see
  *Privacy*).

### Follow-on frame semantics (designed now)

- `call` pushes a frame with `continuation = { kind: 'call', callerNode: <call node id>, returnTo:
  call.next, onError: call.onError }`. On the callee's `end`, the frame pops and the frame directly
  below receives `results.<callerNode> = { ...end.output, $outcome: end.outcome }`, then continues
  at `returnTo`. Nested calls unwind one frame at a time, each writing into its own caller.
- `goto` replaces the top frame and keeps its `continuation`, so a `goto` inside a called flow still
  returns to the original caller's `callerNode` and `returnTo`.
- A callee error pops the frame and goes to `continuation.onError` in the caller, with
  `results.<callerNode> = { error: ... }`; without `onError` it propagates to the next frame down.
- Unversioned references resolve at push time; the frame pins the resolved `version` and `digest`,
  so resume never re-resolves a moving reference.
- `loop.body: { flow }` pushes with `continuation = { kind: 'loopBody', callerNode: <loop id>,
  returnTo: <loop id> }`; the body's output lands in `results.<loop id>`.

## Execution model

### Time

- The graph takes `now?: () => number` (epoch ms, default `Date.now`) and uses it for every time
  decision: deadlines, `retryAt`, wait durations, `input` timeouts, resume event acceptance and
  `recover`. It passes the same `now` to `raceAttempt`. Nothing calls `Date.now()` directly.
- Stored timestamps are **canonical UTC**: exactly the `Date.prototype.toISOString()` form
  (`YYYY-MM-DDTHH:mm:ss.sssZ`). `runStateSchema` enforces it with a pattern; the invariant check
  also requires `new Date(ts).toISOString() === ts`. Offsets other than `Z` and offset-less forms
  are rejected.
- Kinds returning `suspend.deadline` must produce the same form (helper `toTimestamp(ms)`
  exported).
- Hosts resuming across machines own clock agreement; the engine documents that skew shifts
  deadline and `resumeAt` acceptance by the skew amount.

### Step commit

A node transition commits atomically: state writes (`set`), the node result (`setResult` or
`NodeResult.result`), loop counters and the cursor are staged, validated as `JsonValue`, and
applied only once the node has selected its transition. A throw at any point discards the staged
writes.

Commits, each yielded by `FlowRun.next()` as a `RunState` for the host to persist:

| Commit | When | Changes |
|---|---|---|
| **Entry** | a node is entered | `steps` + 1, frame `invocation` + 1, `attempts[node]` created (policy snapshot, deadline) for kinds with `retries` |
| **Attempt checkpoint** | before each new logical attempt of a node with `retries` | `attempts[node].count` + 1, `interruptions` reset to 0, `retryAt` cleared, `inFlight` set |
| **Replay checkpoint** | `recover` finds `inFlight` set | `attempts[node].interruptions` + 1, `count` unchanged, `inFlight` kept; or *Failure → terminal* (`interrupted`) when `maxInterruptions` would be exceeded |
| **Transition** | node selects `next` / `end` | staged writes applied, cursor moved, `attempts` and `inFlight` cleared |
| **Failure → retry** | attempt fails, disposition *retry* | `lastFailure` updated, `inFlight` cleared, `retryAt` set; if wait > `suspendAfterMs`, also `status: 'suspended'` and `pending` (`reason: 'retry'`, `resumeAt = retryAt`) |
| **Failure → terminal** | attempt fails, disposition *terminal* | `lastFailure` recorded; either the `onError` transition (as *Transition*, with the error result) or run `error` |
| **Suspend** | kind suspends | `status: 'suspended'`, `pending` set |

There is no failure commit without a disposition: after any commit, `recover` can tell the next
phase from the state alone (`inFlight` set: replay the attempt; `retryAt` set: wait then attempt;
neither: execute the cursor node, or its next attempt).

`revision` increments on every commit. Entry and checkpoint commits are what make attempt counts
durable: a host that persists every yielded state never exceeds `maxAttempts`, even across crashes.
A host that persists only at suspend or end accepts that a crash may repeat attempts (still at
least once). Nodes without `retries` (`branch`, `set`, `loop`, `end`) combine entry and transition
into one commit, so hosts persisting every yield pay one write per plain node and two to three per
retrying node attempt. Hosts may batch writes (persist every Nth commit or on a timer) and accept
the weaker crash semantics above; the engine is correct either way.

### Delivery guarantee

Node execution is **at least once**. A crash after an action's side effect but before the host
persists the next `RunState` re-runs that attempt on resume. `invocationID`
(`${runID}:${frameIndex}:${invocation}`) is fixed at node entry and stays the same across attempts,
retry suspensions and crash re-runs of that entry; it changes only when the node is entered again
(e.g. the next loop iteration). Actions use it to deduplicate side effects.

A persisted state with `status: 'running'` means the process stopped mid-segment. The host
continues it with `graph.recover({ definition, runState, signal })`:

- **`inFlight` set** (crash mid-attempt): the same logical attempt is **replayed** — same `attempt`
  number, same `invocationID`, `count` unchanged — after a *Replay checkpoint* (see *Step commit*). An interruption never consumes `maxAttempts`, so `maxAttempts: 1` still executes
  at least once. When `interruptions` would exceed `maxInterruptions`, the disposition is terminal
  with reason `interrupted` (guards crash loops). `interruptions` resets when a new logical attempt
  starts.
- **`retryAt` set:** wait until `retryAt` (in-process sleep, or suspend when the remaining wait
  exceeds `suspendAfterMs`), then start the next attempt.
- **Neither:** execute the cursor node (entry already committed) or its next attempt.

The engine takes no lease: two processes resuming the same `RunState` both run. Hosts must persist
with optimistic concurrency on `revision` (write only if the stored revision is the one they
resumed from). The docs must state this prominently.

### On @sozai/flow

A graph-level wrapper owns the segment and translates between `RunState` and `@sozai/flow`. The
underlying generator state is the `RunState`. One `@sozai/flow` handler per node kind; the action is
`{ name: kind, params: { node: id } }`, and each handler returns the next node's action.

The wrapper, not `@sozai/flow`, decides segment boundaries:

- **Suspend.** A handler returning `suspend` makes the wrapper set `status: 'suspended'`, fill
  `pending`, and close the segment. A bare `@sozai/flow` `state` value does not suspend (a further
  `next()` without an action would end the generator), so the wrapper never calls `next()` again on
  that generator. `resume` always builds a new generator from the persisted `RunState`, with action
  `{ name: 'resume', params: { event } }`.
- **Abort.** The only step signal given to `@sozai/flow` is the run abort signal (attempt timeouts
  stay inside handlers, see *Retry policy*). `@sozai/flow` returns the previous value when that
  signal aborts, so the wrapper checks the run signal after each step and itself sets
  `status: 'aborted'`, closing the segment.
- **Commits.** Entry, checkpoint and failure commits are yielded by the wrapper between handler
  phases; `@sozai/flow` sees one handler call per node attempt.
- **End and error** map from the generator's terminal values.

If something in `@sozai/flow` blocks this, fix it there rather than working around it.

## Runtime API

```ts
const graph = createFlowGraph({
  kinds?: Array<NodeKind>,                        // extra kinds; built-ins always present
  actions?: Record<string, Action>,
  retryDefaults?: Record<string, FlowRetryPolicy>,
  maxSteps?: number,                              // default 1000
  runtime?: Runtime,                              // default createRuntime(); getRandomID for runID
  logger?: Logger,                                // default getSozaiLogger('flow-graph')
  recordErrorMessages?: boolean,                  // default false; see Privacy
  random?: () => number,                          // backoff jitter; injectable for tests
  now?: () => number,                             // epoch ms clock; default Date.now (see Time)
  resolver?: FlowResolver,                        // follow-on
})

type Action = (ctx: {
  args: Record<string, JsonValue>
  signal: AbortSignal
  runID: string
  nodeID: string
  invocationID: string
  attempt: number
}) => JsonValue | Promise<JsonValue>

graph.authoringSchema / graph.storageSchema / runStateSchema
graph.check(definition)                                   // { ok, issues }
graph.start({ definition, input, runID?, signal })        // FlowRun: step-wise
graph.resume({ definition, runState, event, signal })     // FlowRun; event: ResumeEvent | { type: 'retry' }
graph.recover({ definition, runState, signal })           // FlowRun; continue a `running` state after a crash
await graph.run({ definition, input, runID?, signal })    // to end or suspend
// => { status, outcome?, output?, pending?, error?, runState }

type FlowRun = AsyncIterable<RunState> & {
  next(): Promise<IteratorResult<RunState, RunState>>     // executes one step
  getState(): RunState
  events: EventEmitter<FlowEvents>                        // node:enter, node:exit, retry, suspend, end
}
```

`runID` defaults to `runtime.getRandomID()`, never `crypto.randomUUID()` directly.

`resume` checks, in order, before invoking any kind hook: `runStateSchema` and invariants;
`status === 'suspended'`; definition `id`/`version`/`digest`; event type matches `pending.reason`
(`value`/`timeout` for `suspend`, `retry` for `retry`); then the time rules:

| Event | Before deadline / `resumeAt` | After |
|---|---|---|
| `value` | accepted | accepted (a late value still wins if no `timeout` has committed) |
| `timeout` | rejected (`FlowResumeError`) | accepted |
| `retry` | rejected | accepted; exhausts the node if past `attempts.deadline` |

A `value` is then validated against `pending.schema`. When a `value` and a `timeout` race, the
first to commit wins; the loser fails the host's optimistic `revision` write. `recover` checks
schema, invariants, digest and `status === 'running'`. Any failure throws (`FlowStateError`,
`FlowVersionMismatchError`, `FlowResumeError`, `FlowInputError`) and leaves the state untouched so
the host can retry.

A kind with `resume` but no `deadline` never receives `timeout`; an `input` without `timeout` never
sets a deadline.

### Errors

- Node fails (after retries): with `onError`, store `results.<id> = { error: { type, code?,
  status?, reason, attempts } }` and go there; without, run `error` (code `node_failed`).
- Other run error codes: `invalid_value`, `invalid_target`, `invalid_suspend`, `max_steps`,
  `loop_exhausted`. Failure `reason` distinguishes `attempts`, `total_timeout`,
  `non_retryable` and `interrupted`; an attempt timeout appears as `lastFailure.type: 'TimeoutInterruption'`.
- Abort signal: run `aborted`.
- `start` with an invalid definition: `FlowDefinitionError` carrying the issues; nothing runs.

## Observability

No metrics API exists in `@sozai/otel`; metrics are derived from spans by collector connectors
(`spanmetrics` for spans, `count` for span events). Span names stay low-cardinality.

Tracer: `createTracerFactory('sozai', <package version>)('flow-graph')`.

**Segments.** A `flow.segment` span covers one `start` or `resume` call up to end, suspend or
abort. It is a **child of the host's active context** (e.g. the HTTP request that resumed the run),
or of an optional `parentContext` param. The first segment captures its own `traceparent`
(`formatTraceparent` of its span context) into `RunState.origin`.

A resume or recover segment **links** to the origin rather than using it as parent, since the run
may resume days later. Conversion: `parseTraceparent(origin.traceparent)` gives
`{ traceID, spanID, traceFlags }`; when valid (`isValidTraceID`, `isValidSpanID`), map it to an OTel
`SpanContext` `{ traceId, spanId, traceFlags, isRemote: true }` and pass it in `SpanOptions.links`
when starting the segment span (links must be given at span start). An invalid or absent origin adds
no link. When tracing is disabled (no valid span context), `origin` is omitted.

**Spans are started with the tracer directly, not `withSpan`.** `withSpan` records the thrown
error's message and exception on the span, which the privacy rules forbid by default. The engine
starts spans itself, catches inside the span scope, and sets only approved attributes; it calls
`recordException` and sets a status message only when `recordErrorMessages` is true.

| Span | Attributes |
|---|---|
| `flow.segment` | `flow.id`, `flow.version`, `flow.run.id`, `flow.segment.kind` (`start`/`resume`/`recover`); at end: `flow.status`, `flow.outcome`, `flow.steps` |
| `flow.node` (child, one per attempt) | `flow.node.id`, `flow.node.kind`, `flow.attempt`, `flow.next`, `flow.loop.iteration`, `flow.branch.case` (index or `default`), `flow.action.name` |

- Retry: span event `flow.retry` on the failed attempt's span with `flow.retry.delay_ms`,
  `flow.retry.suspended`, `error.type`.
- Unhandled error: span status `ERROR`, `error.type` (class name), `flow.error.code`.
- Handled error (`onError` taken): span event `flow.error.handled`, status stays OK.
- Actions run inside the `flow.node` span context, so host spans nest under it.
- Kinds receive the node span in `ExecuteContext.span` to add their own attributes.

**Metric dimension policy** (document for collector config): safe dimensions are `flow.id`,
`flow.version`, `flow.node.kind`, `flow.status`, `flow.outcome`, `flow.error.code`,
`flow.branch.case`. `flow.node.id` is safe when definitions are curated; `flow.run.id` must never
be a dimension.

### Privacy

- Never record `input`, `state`, `results`, action args, prompts or pending data in spans or logs.
- Errors: by default record class name (`error.type`), `flow.error.code` and HTTP-style status only.
  Exception messages and causes may contain user or backend text, so `recordException` and error
  messages are used only when the host sets `recordErrorMessages: true`.

### Logging

**The engine is the only logger.** Kinds do not log failures; they contribute safe fields through
`describeError`, which the engine merges into its records and span attributes. Only the engine
knows the disposition (retry, handled, unhandled), so only it can emit one record per event.

| Event | Level | Fields |
|---|---|---|
| Node attempt failed, will retry | `warn` | `flow.id`, `runID`, `node`, `kind`, `attempt`, `delayMs`, `suspended`, `ErrorMetadata` |
| Node failure handled by `onError` | `warn` | as above plus `reason` |
| Run ends `error` | `error` | `flow.id`, `runID`, `code`, `node`, `reason`, `attempts`, `ErrorMetadata` |
| Invalid definition, version mismatch, invalid state | `error` | `flow.id`, `code`, issue codes |

Logger: the injected `logger` option, default `getSozaiLogger('flow-graph')`. **`traceLogger` is
applied per record, inside the active span** (`traceLogger(logger).warn(...)` at the call site),
because it captures the span that is active when called; wrapping once at construction would miss
segment and node spans.

Run errors must never be silent, whatever logger is used (default or injected). One emission
path handles every `error`-level record:

- `isSetup()` from `@sozai/log` is true: `traceLogger(logger).error(message, metadata)` inside the
  active span, so the record carries trace fields.
- Otherwise (logtape drops everything): one `console.error('[@sozai/flow-graph] <message>', metadata)`
  with the same safe metadata, no trace fields needed.

`warn` records only go to the logger; an unconfigured host drops them.

Every record carries a fixed message plus the metadata above, never the original error object or
its message, unless `recordErrorMessages` is true.

## Dependencies

`@sozai/flow`, `@sozai/schema`, `@sozai/event`, `@sozai/async`, `@sozai/otel`, `@sozai/log`,
`@sozai/runtime`, `@noble/hashes` (add to the catalog).

## Testing

- Filter evaluator: the truth table, row by row; empty combinators rejected by schema.
- `Value` resolution: refs, missing refs to `null`, nested `object`/`array`.
- Checker: one fixture per rule, asserting `code`, `path` and a non-empty `hint`; dominance warning;
  cross-node `resultSchema` checks; `results.<id>.error.*` checked against the handled-error shape
  when `<id>` has `onError`, including an `action` node; a kind declaring top-level `error` in
  `resultSchema` rejected at registration;
  exit-edge cycle rejected.
- Runtime: each node kind; `set` ordering; step commit discards writes on throw; loop limit and
  reset; `onError`; `maxSteps`; `invalid_target`; non-JSON result rejected; abort mid-step.
- Commits: entry, checkpoint, transition, failure and suspend commits yielded in order with the
  specified `revision`/`steps`/`invocation` changes; `invocationID` stable across attempts and retry
  suspensions, new on loop re-entry.
- Retry: retryable and non-retryable errors; `afterMs`; attempt timeout on a handler ignoring its
  signal (late result ignored); policy snapshot survives changed `retryDefaults` in a fresh graph;
  wait past the deadline not scheduled; in-process wait vs suspend with `resumeAt`; early `retry`
  rejected; late `retry` exhausts; `lastFailure` carried through suspension; `describeError`
  returning `Infinity`/`NaN` sanitised, and a missing `type` replaced by the default. Recover: replay checkpoint keeps `count`, `maxAttempts: 1`
  replays once, `maxInterruptions` exceeded ends `interrupted`. Logging: run error reaches the
  console when logging is not set up, with an injected logger too.
- Recovery: `recover` with `inFlight` replays the same attempt and `invocationID` without consuming
  `maxAttempts` (including `maxAttempts: 1`); `maxInterruptions` exceeded ends `interrupted`;
  `recover` with `retryAt` waits (or suspends) until it without recomputing jitter; attempts never
  exceed `maxAttempts` when every yielded state is persisted.
- Invariants: one fixture per status-matrix cell violation; non-canonical timestamps (offset,
  no zone) rejected.
- Time: every time decision driven by injected `now` with fake timers; no direct `Date.now` use.
- Suspend and resume: `input` value, invalid value; `timeout` before deadline rejected, after
  accepted; late `value` accepted; extension kind with `resume` and `data`; JSON round-trip into a
  fresh graph; version and digest mismatch; schema-invalid and invariant-violating `RunState`.
- Validation: non-finite number in definition or input rejected before hashing; nested schema that
  fails to compile.
- Staging: `evaluate` after `setResult` sees the staged value; failed attempt discards it.
- Tracing: in-memory span exporter asserting the span tree, parent from host context, resume link
  built as a remote `SpanContext`, attributes, and no payload, message or exception event by
  default. Logging: a logtape test sink asserting one record per event, trace IDs from the active span, and no raw error objects by
  default.
- Type tests on the public API.

## Follow-on (not v1)

Flow references: `FlowResolver` (`resolve(id, version?) => FlowDefinition`, plus an in-memory map
helper), `call`, `goto`, `loop.body: { flow }`, with the frame semantics above. The checker spans
the resolved flow set: missing references, call cycles (recursion only under a `maxDepth`),
input/output mismatches.
