import type { JSONValue } from '@sozai/json'
import type { Schema } from '@sozai/schema'

import { FlowNodeFailure } from './errors.js'
import type { PreparedFlow } from './resolver.js'
import { builtinSchemas } from './schemas.js'
import type {
  ExecuteContext,
  FlowRetryPolicy,
  Frame,
  NodeKind,
  NodeResult,
  RegisteredNodeKind,
} from './types.js'
import type { Value } from './value.js'

/** Reference to another flow, with an optional pinned version and input values. */
export type FlowReference = { flow: string; version?: number; input?: Record<string, Value> }

/** Node that runs another flow and continues with its result. */
export type CallNode = FlowReference & {
  kind: 'call'
  next: string
  onError?: string
  retry?: FlowRetryPolicy
}

/** Node that hands the run over to another flow. */
export type GotoNode = FlowReference & { kind: 'goto' }

/** Resolves, snapshots and validates referenced flows for the runner. */
export type ReferenceService = {
  prepare(
    ref: { flow: string; version?: number },
    input: JSONValue,
    options?: { signal?: AbortSignal },
  ): Promise<PreparedFlow>
}

/** Internal result that pushes a referenced flow as a new frame. */
export type PushResult = {
  push: {
    ref: { flow: string; version?: number }
    input: JSONValue
    continuation: NonNullable<Frame['continuation']>
  }
}

/** Internal result that replaces the top frame with a referenced flow. */
export type ReplaceResult = {
  replace: { ref: { flow: string; version?: number }; input: JSONValue }
}

/** Node result including the stack transitions reserved for built-in kinds. */
export type InternalNodeResult = NodeResult | PushResult | ReplaceResult

/** Return an internal stack transition from a built-in kind's `execute`. */
export const internalResult = (result: PushResult | ReplaceResult): NodeResult =>
  result as unknown as NodeResult

/** Reference target of a flow reference: `flow` plus `version` only when pinned. */
export const referenceTarget = (reference: FlowReference): PushResult['push']['ref'] => ({
  flow: reference.flow,
  ...(reference.version !== undefined ? { version: reference.version } : {}),
})

/** Parameters for creating the reference node kinds. */
export type ReferenceKindsParams = { references: ReferenceService }

/** Result shape of a `call` node or a flow-body loop: the callee's `outcome` and `output`. */
export const referenceResultSchema: Schema = {
  type: 'object',
  properties: { outcome: { type: 'string' }, output: {} },
  additionalProperties: false,
}

/** Reference service that resolves nothing, for kind maps built outside a graph. */
export const unavailableReferences: ReferenceService = {
  prepare: () => Promise.reject(new FlowNodeFailure({ code: 'missing_flow' })),
}

const target = (path: string, id: string) => ({ path: [path], id })

/** Resolve a reference's `input` values in the caller scope; an omitted `input` is `{}`. */
export const resolveReferenceInput = (
  reference: FlowReference,
  ctx: ExecuteContext,
): Record<string, JSONValue> =>
  Object.fromEntries(
    Object.entries(reference.input ?? {}).map(([key, value]) => [key, ctx.resolve(value)]),
  )

/** Create the `call` and `goto` node kinds. */
export function referenceKinds(_params: ReferenceKindsParams): Array<RegisteredNodeKind> {
  const call: NodeKind<CallNode> = {
    kind: 'call',
    schema: builtinSchemas.call,
    retries: true,
    targets: (node) => [
      target('next', node.next),
      ...(node.onError ? [target('onError', node.onError)] : []),
    ],
    resultSchema: () => referenceResultSchema,
    execute: (node, ctx) => {
      // The runner resolves, snapshots and validates the callee before pushing it.
      return internalResult({
        push: {
          ref: referenceTarget(node),
          input: resolveReferenceInput(node, ctx),
          continuation: {
            kind: 'call',
            callerNode: ctx.nodeID,
            returnTo: node.next,
            ...(node.onError ? { onError: node.onError } : {}),
          },
        },
      })
    },
  }

  const goto: NodeKind<GotoNode> = {
    kind: 'goto',
    schema: builtinSchemas.goto,
    targets: () => [],
    execute: (node, ctx) => {
      // The runner resolves, snapshots and validates the target before replacing the frame.
      return internalResult({
        replace: { ref: referenceTarget(node), input: resolveReferenceInput(node, ctx) },
      })
    },
  }

  return [call, goto] as Array<RegisteredNodeKind>
}
