# @sozai/flow-graph

Persistable JSON flow graphs with direct node kind execution. Check definitions before execution. Each run yields JSON state at durable commit points.

Built-in kinds cover branching, state writes, bounded loops, host actions, external input, flow calls, and terminal outcomes. The package also supports retries, tracing, and safe error logging.

## Installation

```sh
pnpm add @sozai/flow-graph
```

## Define and run a flow

```ts
import { createFlowGraph, createMapResolver, formatIssues } from '@sozai/flow-graph'

const definition = {
  id: 'support/triage',
  name: 'Triage',
  version: 1,
  start: 'ask',
  nodes: {
    ask: { kind: 'input', prompt: { value: 'What happened?' }, next: 'done' },
    done: {
      kind: 'end',
      output: { answer: { ref: ['results', 'ask'] } },
    },
  },
}

const graph = createFlowGraph({ resolver: createMapResolver([definition]) })
const checked = graph.check(definition)
if (checked.issues) throw new Error(formatIssues(checked.issues))

const first = await graph.run({ definition }) // suspended at ask
const resumed = graph.resume({
  runState: JSON.parse(JSON.stringify(first.runState)),
  event: { type: 'value', value: 'A delivery is late' },
})
for await (const commit of resumed) {
  // Persist each commit using compare-and-swap on `revision`.
}
console.log(resumed.getState().output)
```

`graph.authoringSchema` describes executable definitions, including stored ones, for editors and model generation. Its built-in parts compile under Ajv strict mode, so `createValidator(graph.authoringSchema)` needs no `{ strict: false }` unless a custom kind schema is not strict-clean.

`graph.check()` is synchronous and local. It reports repairable issues with a code, path, hint, and severity. `formatIssues()` turns them into compact text. `graph.check()` and `graph.checkFlows()` return a `FlowCheckResult` in Standard Schema result shape: `{ value, warnings }` with the checked definition when no issue is an error, otherwise `{ issues }` with every issue, warnings included. Test `result.issues` to tell them apart. Definition digests hash the canonical JSON produced by `@sozai/json`.

`FlowDefinitionError`, `FlowInputError`, `FlowStateError`, and `FlowResumeError` expose Standard Schema compatible `issues` arrays with messages and paths. Input and state schema failures preserve the validator's issues. State invariant messages use fixed text and never include payload values.

## Flow references

A flow can call, hand over to, or loop over other flows. A `FlowResolver` supplies the definitions:

```ts
type FlowResolver = {
  resolve(
    id: string,
    version?: number,
    options?: { signal?: AbortSignal },
  ): FlowDefinition | Promise<FlowDefinition>
}
```

The runtime passes the run's `signal` in `options` when it resolves frames on `resume`/`recover`, runs the start preflight, and resolves a reference at push time, so an async resolver can stop a lookup once the run aborts. `createMapResolver` ignores it.

`createMapResolver(definitions)` is an in-memory resolver. An unversioned lookup returns the highest version, and a miss throws `FlowReferenceError`. Pass a resolver to `createFlowGraph({ resolver, maxDepth })`. `maxDepth` bounds the frame stack including the root and defaults to 16.

Three node shapes reference another flow. Each takes `flow`, optional `version` and optional `input` (values, resolved in the caller scope; an omitted `input` is `{}`):

- `call` runs the callee as a new frame, then continues at `next`. The callee's `end` output is available as `results.<callNode>.output` and its outcome as `results.<callNode>.outcome`. A failure that no retry handles is routed to `onError`.
- `goto` replaces the current frame with the target flow. The continuation of the replaced frame is kept, so an `end` in the target returns to the original caller. A `goto` in the root flow repins the root.
- `loop` with `body: { flow, version?, input? }` runs the body flow on each iteration while `while` holds, up to `maxIterations`. Each body run's result lands in `results.<loopNode>` as `{ output, outcome? }`, so the next `while` check and the body `input` can read the previous iteration.

```ts
const greet = {
  id: 'greet',
  name: 'Greet',
  version: 1,
  start: 'done',
  input: { type: 'object', required: ['name'] },
  nodes: {
    done: { kind: 'end', output: { text: { ref: ['input', 'name'] } } },
  },
}
const main = {
  id: 'main',
  name: 'Main',
  version: 1,
  start: 'hello',
  nodes: {
    hello: {
      kind: 'call',
      flow: 'greet',
      version: 1,
      input: { name: { value: 'Ada' } },
      next: 'done',
    },
    done: { kind: 'end', output: { text: { ref: ['results', 'hello', 'output', 'text'] } } },
  },
}

const graph = createFlowGraph({ resolver: createMapResolver([main, greet]) })
await graph.run({ definition: main })
```

A loop with a flow body runs `tick` until its output `n` reaches 3. The first `while` check and body input see no result yet (a missing path reads as `null`):

```ts
const tick = {
  id: 'tick',
  name: 'Tick',
  version: 1,
  start: 'inc',
  nodes: {
    inc: { kind: 'action', name: 'inc', args: { prev: { ref: ['input', 'prev'] } }, next: 'done' },
    done: { kind: 'end', output: { n: { ref: ['results', 'inc'] } } },
  },
}
const counter = {
  id: 'counter',
  name: 'Counter',
  version: 1,
  start: 'count',
  nodes: {
    count: {
      kind: 'loop',
      maxIterations: 5,
      while: {
        not: { path: ['results', 'count', 'output', 'n'], is: { greaterThanOrEqualTo: 3 } },
      },
      body: {
        flow: 'tick',
        version: 1,
        input: { prev: { ref: ['results', 'count', 'output', 'n'] } },
      },
      exit: 'done',
    },
    done: { kind: 'end', output: { n: { ref: ['results', 'count', 'output', 'n'] } } },
  },
}

const counting = createFlowGraph({
  resolver: createMapResolver([counter, tick]),
  actions: { inc: ({ args }) => ((args.prev as number | null) ?? 0) + 1 },
})
await counting.run({ definition: counter }) // output: { n: 3 }
```

Run state holds a stack of `frames`. The root frame is first and the active frame is last. Each frame pins its flow `id`, `version` and digest, so `resume()` and `recover()` take no `definition`: they resolve every frame from the resolver, snapshot it, and reject a changed definition with `FlowVersionMismatchError`. A resolver miss rejects with the resolver's own error. Both methods require a resolver and throw `TypeError` without one. A single-flow host registers its flow with `createMapResolver([definition])`.

Checks on resume are split. Definition-free checks (state schema, stack structure, event) throw synchronously. Resolution, digests and definition-dependent invariants run on the first `next()`, which rejects and commits nothing on failure.

Abort takes precedence over resolution. If the run's `signal` is already aborted on the first `next()`, the run commits `aborted` without resolving any definition. If the resolver rejects while the signal is aborted, the run commits `aborted` instead of rejecting.

Every executed definition is a JSON snapshot taken at resolution, so a resolver that later mutates its objects cannot change a pinned frame. A non-JSON or locally invalid callee fails with `invalid_flow`.

`graph.start()` with a definition that references flows requires a resolver. It runs `checkFlows` lazily on the first `next()`: error issues reject with `FlowDefinitionError` and commit nothing, warnings do not block.

`graph.checkFlows(definition)` resolves references transitively and reports, with issue paths prefixed by `['flows', id, version]` inside a callee:

- `missing_flow` (error): the resolver throws or returns a different `id` or `version`; the message tells the two apart and never includes the resolver's error.
- `unbounded_cycle` (error): a cross-flow cycle made only of `goto` edges.
- `recursive_call` (warning): a cycle through a `call` or loop body; `maxDepth` bounds it.
- `input_mismatch` (error): a simple object callee `input` schema with a `required` key the reference omits, or an extra key when `additionalProperties` is `false`. Other schemas are validated only at push time.
- `invalid_result_path` (error): `results.<call>.output.<key>` where the callee, or a flow it reaches by `goto`, never returns `key`. It is skipped when a node of a terminal custom kind is in that set, and also applies through unversioned references, against the version resolved at check time.
- `unversioned_reference` (warning): the reference resolves at push time and may drift.

`checkFlows` is a preflight. Push time re-runs local `check` and input validation on the pushed snapshot, so every executed flow is locally valid and receives valid input. An unversioned reference is pinned when pushed: a later push, or a run in another process, may resolve a different version, and an output key the checker saw may then read as missing.

### Failures and retries across frames

A `call` node uses the retry policy fields except `attemptTimeoutMs`, which is rejected in `retry` and in `retryDefaults.call`. `totalTimeoutMs` is a retry deadline measured from call entry. It is checked when the callee fails and before each re-push. It never interrupts a running or suspended callee, so use `input.timeout` or action timeouts inside the callee for a wall-clock bound. A retry re-pushes the callee with the same `invocationID`. After a retry is scheduled, a later deadline stop records the `RunError` and result on the call node in the caller frame.

A failure with code `node_failed`, `loop_exhausted`, `missing_flow`, `invalid_flow`, `max_depth` or `invalid_input` in a callee walks down the stack. The first caller that can retry the call or has `onError` handles it, and one commit removes the frames above it. If nobody handles it, the run ends with the stack intact, and `RunError.flow` names the flow where the failure started. Other codes (`invalid_value`, `invalid_target`, `invalid_suspend`, `max_steps`) end the run directly.

A handled failure is stored as `results.<callNode>.error`. Failures that came from a callee, through the walk or a retry deadline stop before a re-push, have `type: 'FlowCallError'`. The call node's own failures (`missing_flow`, `invalid_flow`, `max_depth`, `invalid_input`, recovery interruptions) carry the default error type. These reference codes apply only to `call`, `goto` and flow-body `loop` nodes: a custom kind throwing `FlowNodeFailure` with one of them fails as an ordinary `node_failed` node. Handled-failure log records carry the handling caller's `flow.id`.

Every node entry draws an invocation ID, `${runID}:n`, from the run-level `invocation` counter. A `goto` node's own entry draws one like any node; the frame replacement it triggers does not, and neither do push, pop and unwind.

### Terminal kinds

A `NodeKind` with `terminal: true` may return `end`, and the checker treats its nodes as ends. Any other custom kind returning `end` fails with `invalid_value`. Output of a terminal custom kind is unconstrained for `invalid_result_path`.

### Unconstrained result schemas

A `resultSchema` path check accepts any remaining path below `true`, a schema with only annotation keywords (`{}`, `{ description }`), or `additionalProperties: true`. Local `$ref`s are followed. Keywords such as `properties`, `patternProperties` and `anyOf` constrain. An absent `additionalProperties` stays strict. Result schemas compile without Ajv strict mode, so path-only shapes such as `properties` without `type` are fine.

## Input decline

`input` accepts `decline: { to }`. A host answers a refused prompt with `{ type: 'decline', reason?: 'decline' | 'cancel' }`, and the run routes to `to` with `results.<input> = { declined: reason ?? 'decline' }`. Without the edge, `decline` fails the node with `invalid_suspend`. Custom kinds receive `decline` in their own `resume` and should throw `FlowNodeFailure({ code: 'invalid_suspend' })` if they do not support it.

## Persistence and delivery

`graph.start()`, `graph.resume()`, and `graph.recover()` return a `FlowRun`. Each `next()` returns one committed `RunState`. Commits include node entry, attempt checkpoints, retry decisions, transitions, and suspensions. `graph.run()` consumes a new run until it ends or suspends.

`FlowRun.return()` stops a segment without committing anything: it ends the segment span and later `next()` calls return `done` with the current state. It is idempotent, safe before the first `next()`, after a rejected `next()` and after completion, and rejects while a `next()` is pending. `break` in a `for await` loop calls it. A host that abandons a run should call it so the segment span ends.

Persist **every yielded state** for the strongest retry bound. Execution is **at least once**. A process can crash after a side effect and before persisting its next commit.

Pass `invocationID` to external systems as an idempotency key. `recover()` replays a persisted `inFlight` attempt with the same ID and logical attempt number.

Hosts must use optimistic concurrency on `revision`. Two processes can otherwise resume the same run. Compare each write against the revision read before the segment or previous commit.

Retry policies are snapshotted at node entry, including the absolute total deadline. Waiting retries may stay in process or suspend with `pending.reason: 'retry'`. A host sends `{ type: 'retry' }` at or after `pending.resumeAt`.

Input suspensions accept `{ type: 'value', value }` or `{ type: 'decline' }`. Timed input accepts `{ type: 'timeout' }` at or after `pending.deadline`. All times are canonical UTC timestamps. Clock skew between machines changes when deadlines and `resumeAt` become eligible.

## Extensions and observability

`defineNodeKind()` preserves the type of a custom node kind. A kind supplies a schema, static outgoing targets, and `execute`. Optional hooks include `resume`, `resultSchema`, `check`, `retryable`, and `describeError`.

The engine stages `setResult` writes and discards them if the attempt fails. `describeError` must return safe metadata without user or backend messages.

The graph emits `flow.segment` and `flow.node` spans, with `flow.retry` and `flow.error.handled` events. When the lazy preparation on the first `next()` (resolution or the start preflight) rejects, the segment span stays open so a later `next()` can retry. `return()` then ends it with an error status and `error.type`; the exception event is recorded only with `recordErrorMessages: true`. `graph.run()` calls `return()` before rethrowing such a rejection. Each `flow.node` span carries the `flow.id` of the frame running the node and its `flow.depth` (0 for the root frame).

Safe collector dimensions are `flow.id`, `flow.version`, `flow.node.kind`, `flow.status`, `flow.outcome`, `flow.error.code`, and `flow.branch.case`. Use `flow.node.id` only when definitions are curated. Never use `flow.run.id` as a metric dimension.

Inputs, state, results, prompts, and action arguments are not logged or traced. Original error messages and exceptions require `recordErrorMessages: true`.
