# @sozai/flow-graph

Persistable JSON flow graphs built on `@sozai/flow`. Check definitions before execution. Each run yields JSON state at durable commit points.

Built-in kinds cover branching, state writes, bounded loops, host actions, external input, and terminal outcomes. The package also supports retries, tracing, and safe error logging.

## Installation

```sh
pnpm add @sozai/flow-graph
```

## Define and run a flow

```ts
import { createFlowGraph } from '@sozai/flow-graph'

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

const graph = createFlowGraph()
const checked = graph.check(definition)
if (!checked.ok) throw new Error('Invalid flow')

const first = await graph.run({ definition }) // suspended at ask
const resumed = graph.resume({
  definition,
  runState: JSON.parse(JSON.stringify(first.runState)),
  event: { type: 'value', value: 'A delivery is late' },
})
for await (const commit of resumed) {
  // Persist each commit using compare-and-swap on `revision`.
}
console.log(resumed.getState().output)
```

`graph.authoringSchema` describes executable definitions for editors and model generation. `graph.storageSchema` also accepts reserved `call`, `goto`, and external loop body shapes. These shapes cannot execute in v1.

`graph.check()` reports repairable issues with a code, path, and hint. `formatIssues()` turns them into compact text. Definition digests hash the canonical JSON produced by `@sozai/json`.

`FlowDefinitionError`, `FlowInputError`, `FlowStateError`, and `FlowResumeError` expose Standard Schema compatible `issues` arrays with messages and paths. Input and state schema failures preserve the validator's issues. State invariant messages use fixed text and never include payload values.

## Persistence and delivery

`graph.start()`, `graph.resume()`, and `graph.recover()` return a `FlowRun`. Each `next()` returns one committed `RunState`. Commits include node entry, attempt checkpoints, retry decisions, transitions, and suspensions. `graph.run()` consumes a new run until it ends or suspends.

Persist **every yielded state** for the strongest retry bound. Execution is **at least once**. A process can crash after a side effect and before persisting its next commit.

Pass `invocationID` to external systems as an idempotency key. `recover()` replays a persisted `inFlight` attempt with the same ID and logical attempt number.

Hosts must use optimistic concurrency on `revision`. Two processes can otherwise resume the same run. Compare each write against the revision read before the segment or previous commit.

Retry policies are snapshotted at node entry, including the absolute total deadline. Waiting retries may stay in process or suspend with `pending.reason: 'retry'`. A host sends `{ type: 'retry' }` at or after `pending.resumeAt`.

Input suspensions accept `{ type: 'value', value }`. Timed input accepts `{ type: 'timeout' }` at or after `pending.deadline`. All times are canonical UTC timestamps. Clock skew between machines changes when deadlines and `resumeAt` become eligible.

## Extensions and observability

`defineNodeKind()` preserves the type of a custom node kind. A kind supplies a schema, static outgoing targets, and `execute`. Optional hooks include `resume`, `resultSchema`, `check`, `retryable`, and `describeError`.

The engine stages `setResult` writes and discards them if the attempt fails. `describeError` must return safe metadata without user or backend messages.

The graph emits `flow.segment` and `flow.node` spans, with `flow.retry` and `flow.error.handled` events.

Safe collector dimensions are `flow.id`, `flow.version`, `flow.node.kind`, `flow.status`, `flow.outcome`, `flow.error.code`, and `flow.branch.case`. Use `flow.node.id` only when definitions are curated. Never use `flow.run.id` as a metric dimension.

Inputs, state, results, prompts, and action arguments are not logged or traced. Original error messages and exceptions require `recordErrorMessages: true`.
