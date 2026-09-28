import type { RetryDecision, RetryPolicy } from '@sozai/async'
import type { EventEmitter } from '@sozai/event'
import type { JSONValue } from '@sozai/json'
import type { Logger } from '@sozai/log'
import type { Context, Span } from '@sozai/otel'
import type { Runtime } from '@sozai/runtime'
import type { Schema } from '@sozai/schema'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { Filter } from './filter.js'
import type { Scope, Value } from './value.js'

/** Retry policy with suspension and recovery limits. */
export type FlowRetryPolicy = RetryPolicy & { suspendAfterMs?: number; maxInterruptions?: number }

/** Persistable graph definition with a stable identifier and version. */
export type FlowDefinition = {
  id: string
  name: string
  version: number
  description?: string
  input?: Schema
  start: string
  nodes: Record<string, FlowNode>
}

/** Base shape shared by built-in and registered nodes. */
export type FlowNode = { kind: string; description?: string; [key: string]: unknown }
/** A Standard Schema issue with repair metadata for flow definitions. */
export type FlowIssue = StandardSchemaV1.Issue & {
  severity: 'error' | 'warning'
  path: Array<string | number>
  code: string
  message: string
  hint: string
}

/** Details used to report a flow definition issue. */
export type IssueParams = {
  code: string
  path: Array<string | number>
  message: string
  hint: string
  severity?: 'error' | 'warning'
}

/** Definition and issue reporter supplied to a node kind check. */
export type CheckContext = {
  definition: FlowDefinition
  nodeID: string
  issue: (params: IssueParams) => FlowIssue
}

/** Safe error dimensions recorded in run state. */
export type ErrorMetadata = { type: string; code?: string; status?: number; retryAfterMs?: number }

/** External input or timeout delivered to a suspended node. */
export type ResumeEvent = { type: 'value'; value: JSONValue } | { type: 'timeout' }

/** Transition, completion, or suspension produced by a node. */
export type NodeResult =
  | { next: string; result?: JSONValue }
  | { end: { outcome?: string; output?: Record<string, JSONValue> } }
  | { suspend: { prompt?: JSONValue; schema?: Schema; data?: JSONValue; deadline?: string } }

/** Runtime services and scoped data supplied to a node. */
export type ExecuteContext = {
  nodeID: string
  runID: string
  invocationID: string
  attempt: number
  pending?: { data?: JSONValue }
  scope: Readonly<Scope>
  resolve: (value: Value) => JSONValue
  evaluate: (filter: Filter) => boolean
  setResult: (value: JSONValue) => void
  signal: AbortSignal
  span: Span
  logger: Logger
  runtime: Runtime
}

/** Schema and behaviour for one executable node kind. */
export type NodeKind<Node extends { kind: string } = FlowNode> = {
  kind: Node['kind']
  schema: Schema
  targets: (node: Node) => Array<{ path: Array<string | number>; id: string }>
  resultSchema?: (node: Node) => Schema
  retries?: boolean
  describeError?: (error: unknown) => ErrorMetadata
  check?: (node: Node, ctx: CheckContext) => Array<FlowIssue>
  execute: (node: Node, ctx: ExecuteContext) => NodeResult | Promise<NodeResult>
  resume?: (node: Node, ctx: ExecuteContext, event: ResumeEvent) => NodeResult | Promise<NodeResult>
  retryable?: (error: unknown) => RetryDecision
}

/** Preserve a custom node kind type during registration. */
export const defineNodeKind = <Node extends { kind: string }>(
  kind: NodeKind<Node>,
): NodeKind<Node> => kind

/** Node kind after its concrete node type is erased. */
export type RegisteredNodeKind = Omit<NodeKind<never>, 'kind'> & { kind: string }

/** Host operation invoked by an action node. */
export type Action = (ctx: {
  args: Record<string, JSONValue>
  signal: AbortSignal
  runID: string
  nodeID: string
  invocationID: string
  attempt: number
}) => JSONValue | Promise<JSONValue>

/** Active graph frame persisted with a run. */
export type Frame = {
  flow: { id: string; version: number; digest: string }
  node: string
  input: JSONValue
  state: Record<string, JSONValue>
  results: Record<string, JSONValue>
  loops: Record<string, number>
  invocation: number
  attempts: Record<string, NodeAttempts>
  continuation?: {
    kind: 'call' | 'loopBody'
    callerNode: string
    returnTo: string
    onError?: string
  }
}

/** Retry progress persisted for an active node. */
export type NodeAttempts = {
  invocationID: string
  policy: FlowRetryPolicy
  count: number
  interruptions: number
  deadline?: string
  retryAt?: string
  lastFailure?: ErrorMetadata
}

/** External work required before a run can continue. */
export type Pending = {
  node: string
  reason: 'suspend' | 'retry'
  prompt?: JSONValue
  schema?: Schema
  data?: JSONValue
  deadline?: string
  resumeAt?: string
}

/** Safe terminal error summary stored in run state. */
export type RunError = {
  code: string
  name: string
  node?: string
  reason?: 'attempts' | 'total_timeout' | 'non_retryable' | 'interrupted'
  attempts?: number
  lastFailure?: ErrorMetadata
}

/** JSON state committed at each durable execution point. */
export type RunState = {
  runID: string
  revision: number
  status: 'running' | 'suspended' | 'ended' | 'error' | 'aborted'
  frames: Array<Frame>
  steps: number
  inFlight?: { node: string; attempt: number; invocationID: string }
  origin?: { traceparent: string }
  pending?: Pending
  outcome?: string
  output?: Record<string, JSONValue>
  error?: RunError
}

/** Events emitted at node and run transitions. */
export type FlowEvents = {
  'node:enter': { node: string; runState: RunState }
  'node:exit': { node: string; runState: RunState }
  retry: { node: string; delayMs: number; runState: RunState }
  suspend: { node: string; runState: RunState }
  end: { runState: RunState }
}

/** Async iterator over committed run states. */
export type FlowRun = AsyncIterable<RunState> & {
  next(): Promise<IteratorResult<RunState, RunState>>
  getState(): RunState
  events: EventEmitter<FlowEvents>
}

/** Registration, retry, clock, and observability options. */
export type FlowGraphOptions = {
  kinds?: Array<RegisteredNodeKind>
  actions?: Record<string, Action>
  retryDefaults?: Record<string, FlowRetryPolicy>
  maxSteps?: number
  runtime?: Runtime
  logger?: Logger
  recordErrorMessages?: boolean
  random?: () => number
  now?: () => number
}

/** Definition and input for a new run. */
export type StartParams = {
  definition: FlowDefinition
  input?: JSONValue
  runID?: string
  signal?: AbortSignal
  parentContext?: Context
}

/** Persisted suspension and event used to continue a run. */
export type ResumeParams = {
  definition: FlowDefinition
  runState: RunState
  event: ResumeEvent | { type: 'retry' }
  signal?: AbortSignal
  parentContext?: Context
}

/** Persisted running state used after a process interruption. */
export type RecoverParams = {
  definition: FlowDefinition
  runState: RunState
  signal?: AbortSignal
  parentContext?: Context
}

/** Checked graph runtime and its lifecycle operations. */
export type FlowGraph = {
  authoringSchema: Schema
  storageSchema: Schema
  runStateSchema: Schema
  check: (definition: unknown) => { ok: boolean; issues: Array<FlowIssue> }
  start: (params: StartParams) => FlowRun
  resume: (params: ResumeParams) => FlowRun
  recover: (params: RecoverParams) => FlowRun
  run: (params: StartParams) => Promise<{
    status: RunState['status']
    outcome?: string
    output?: Record<string, JSONValue>
    pending?: Pending
    error?: RunError
    runState: RunState
  }>
}
