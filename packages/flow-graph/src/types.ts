import type { RetryDecision, RetryPolicy } from '@sozai/async'
import type { EventEmitter } from '@sozai/event'
import type { JSONValue } from '@sozai/json'
import type { Logger } from '@sozai/log'
import type { Context, Span } from '@sozai/otel'
import type { Runtime } from '@sozai/runtime'
import type { Schema } from '@sozai/schema'

import type { Filter } from './filter.js'
import type { Scope, Value } from './value.js'

export type FlowRetryPolicy = RetryPolicy & { suspendAfterMs?: number; maxInterruptions?: number }
export type FlowDefinition = {
  id: string
  name: string
  version: number
  description?: string
  input?: Schema
  start: string
  nodes: Record<string, FlowNode>
}
export type FlowNode = { kind: string; description?: string; [key: string]: unknown }
export type FlowIssue = {
  severity: 'error' | 'warning'
  path: Array<string | number>
  code: string
  message: string
  hint: string
}
export type CheckContext = {
  definition: FlowDefinition
  nodeID: string
  issue: (code: string, path: Array<string | number>, message: string, hint: string) => FlowIssue
}
export type ErrorMetadata = { type: string; code?: string; status?: number; retryAfterMs?: number }
export type ResumeEvent = { type: 'value'; value: JSONValue } | { type: 'timeout' }
export type NodeResult =
  | { next: string; result?: JSONValue }
  | { end: { outcome?: string; output?: Record<string, JSONValue> } }
  | { suspend: { prompt?: JSONValue; schema?: Schema; data?: JSONValue; deadline?: string } }
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
export type NodeKind<N extends { kind: string } = FlowNode> = {
  kind: string
  schema: Schema
  targets: (node: N) => Array<{ path: Array<string | number>; id: string }>
  resultSchema?: (node: N) => Schema
  retries?: boolean
  describeError?: (error: unknown) => ErrorMetadata
  check?: (node: N, ctx: CheckContext) => Array<FlowIssue>
  execute: (node: N, ctx: ExecuteContext) => NodeResult | Promise<NodeResult>
  resume?: (node: N, ctx: ExecuteContext, event: ResumeEvent) => NodeResult | Promise<NodeResult>
  retryable?: (error: unknown) => RetryDecision
}
export const defineNodeKind = <N extends { kind: string }>(kind: NodeKind<N>): NodeKind<N> => kind
export type Action = (ctx: {
  args: Record<string, JSONValue>
  signal: AbortSignal
  runID: string
  nodeID: string
  invocationID: string
  attempt: number
}) => JSONValue | Promise<JSONValue>
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
export type NodeAttempts = {
  invocationID: string
  policy: FlowRetryPolicy
  count: number
  interruptions: number
  deadline?: string
  retryAt?: string
  lastFailure?: ErrorMetadata
}
export type Pending = {
  node: string
  reason: 'suspend' | 'retry'
  prompt?: JSONValue
  schema?: Schema
  data?: JSONValue
  deadline?: string
  resumeAt?: string
}
export type RunError = {
  code: string
  name: string
  node?: string
  reason?: 'attempts' | 'total_timeout' | 'non_retryable' | 'interrupted'
  attempts?: number
  lastFailure?: ErrorMetadata
}
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
export type FlowEvents = {
  'node:enter': { node: string; runState: RunState }
  'node:exit': { node: string; runState: RunState }
  retry: { node: string; delayMs: number; runState: RunState }
  suspend: { node: string; runState: RunState }
  end: { runState: RunState }
}
export type FlowRun = AsyncIterable<RunState> & {
  next(): Promise<IteratorResult<RunState, RunState>>
  getState(): RunState
  events: EventEmitter<FlowEvents>
}
export type FlowGraphOptions = {
  kinds?: Array<NodeKind<never>>
  actions?: Record<string, Action>
  retryDefaults?: Record<string, FlowRetryPolicy>
  maxSteps?: number
  runtime?: Runtime
  logger?: Logger
  recordErrorMessages?: boolean
  random?: () => number
  now?: () => number
}
export type StartParams = {
  definition: FlowDefinition
  input?: JSONValue
  runID?: string
  signal?: AbortSignal
  parentContext?: Context
}
export type ResumeParams = {
  definition: FlowDefinition
  runState: RunState
  event: ResumeEvent | { type: 'retry' }
  signal?: AbortSignal
  parentContext?: Context
}
export type RecoverParams = {
  definition: FlowDefinition
  runState: RunState
  signal?: AbortSignal
  parentContext?: Context
}
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
