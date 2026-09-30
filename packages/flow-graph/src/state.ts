import { assertRetryPolicy } from '@sozai/async'
import { isJSONValue } from '@sozai/json'
import type { Schema, Validator } from '@sozai/schema'
import { createValidator, ValidationError } from '@sozai/schema'

import { FlowStateError } from './errors.js'
import { defaultMaxDepth, top, topIndex } from './frames.js'
import { runStateSchema } from './schemas.js'
import { isCanonicalTimestamp } from './time.js'
import type { FlowDefinition, NodeAttempts, NodeKind, RunState } from './types.js'

const validate = createValidator(runStateSchema, { strict: false })

type IssuePath = Array<string | number>

type AssertAttemptsParams = {
  attempts: NodeAttempts
  path: IssuePath
  state: RunState
  active: boolean
}

function invalidState(message: string, path: IssuePath): never {
  throw new FlowStateError({ issues: [{ message, path }] })
}

function assertAttempts(params: AssertAttemptsParams): void {
  const { attempts, path, state, active } = params
  const inFlight = active && state.inFlight !== undefined

  try {
    assertRetryPolicy(attempts.policy)
  } catch {
    invalidState('Retry policy is invalid.', [...path, 'policy'])
  }

  if (
    attempts.policy.suspendAfterMs !== undefined &&
    attempts.policy.totalTimeoutMs !== undefined &&
    attempts.policy.suspendAfterMs >= attempts.policy.totalTimeoutMs
  ) {
    invalidState('Retry suspend threshold must precede total timeout.', [
      ...path,
      'policy',
      'suspendAfterMs',
    ])
  }

  if (attempts.count < 0 || attempts.count > attempts.policy.maxAttempts) {
    invalidState('Retry attempt count is outside policy bounds.', [...path, 'count'])
  }

  if (attempts.interruptions > (attempts.policy.maxInterruptions ?? 3)) {
    invalidState('Retry interruption count is outside policy bounds.', [...path, 'interruptions'])
  }

  if (
    attempts.count === 0 &&
    (attempts.interruptions !== 0 || attempts.lastFailure || attempts.retryAt || inFlight)
  ) {
    invalidState('Initial retry attempt has conflicting progress.', path)
  }

  if (attempts.deadline && !isCanonicalTimestamp(attempts.deadline)) {
    invalidState('Retry deadline must be a canonical UTC timestamp.', [...path, 'deadline'])
  }

  if (attempts.retryAt && !isCanonicalTimestamp(attempts.retryAt)) {
    invalidState('Retry time must be a canonical UTC timestamp.', [...path, 'retryAt'])
  }

  if (attempts.retryAt && (attempts.count < 1 || inFlight)) {
    invalidState('Scheduled retry conflicts with attempt progress.', [...path, 'retryAt'])
  }
}

function assertStatus(state: RunState, nodeID: string, attempts?: NodeAttempts): void {
  const terminal = ['ended', 'error', 'aborted'].includes(state.status)

  if (terminal && state.pending) {
    invalidState('Terminal run cannot have pending work.', ['pending'])
  }

  if (terminal && state.inFlight) {
    invalidState('Terminal run cannot have an in-flight attempt.', ['inFlight'])
  }

  if (terminal && attempts?.retryAt) {
    invalidState('Terminal run cannot have a scheduled retry.', [
      'frames',
      topIndex(state),
      'attempts',
      nodeID,
      'retryAt',
    ])
  }

  if (state.status === 'running' && state.pending) {
    invalidState('Running run cannot have pending work.', ['pending'])
  }

  if (state.status === 'running' && state.outcome !== undefined) {
    invalidState('Running run cannot have an outcome.', ['outcome'])
  }

  if (state.status === 'running' && state.output !== undefined) {
    invalidState('Running run cannot have output.', ['output'])
  }

  if (state.status === 'running' && state.error !== undefined) {
    invalidState('Running run cannot have an error.', ['error'])
  }

  if (state.status === 'running' && attempts?.retryAt && state.inFlight) {
    invalidState('Running retry cannot also be in flight.', ['inFlight'])
  }

  if (state.status === 'suspended' && !state.pending) {
    invalidState('Suspended run requires pending work.', ['pending'])
  }

  if (state.status === 'suspended' && state.inFlight) {
    invalidState('Suspended run cannot have an in-flight attempt.', ['inFlight'])
  }

  if (state.status === 'suspended' && state.outcome !== undefined) {
    invalidState('Suspended run cannot have an outcome.', ['outcome'])
  }

  if (state.status === 'suspended' && state.output !== undefined) {
    invalidState('Suspended run cannot have output.', ['output'])
  }

  if (state.status === 'suspended' && state.error !== undefined) {
    invalidState('Suspended run cannot have an error.', ['error'])
  }

  if (
    state.pending?.reason === 'retry' &&
    (!attempts?.retryAt ||
      attempts.retryAt !== state.pending.resumeAt ||
      state.pending.deadline !== undefined ||
      state.pending.schema !== undefined ||
      state.pending.data !== undefined ||
      state.pending.prompt !== undefined)
  ) {
    invalidState('Pending retry does not match scheduled retry.', ['pending'])
  }

  if (state.pending?.reason === 'suspend' && (attempts?.retryAt || state.pending.resumeAt)) {
    invalidState('Pending input conflicts with scheduled retry.', ['pending'])
  }

  if ((state.status === 'error' && !state.error) || (state.status !== 'error' && state.error)) {
    invalidState('Run error does not match status.', ['error'])
  }

  if (state.status !== 'ended' && (state.outcome !== undefined || state.output !== undefined)) {
    invalidState('Run result requires ended status.', ['status'])
  }
}

function invocationNumber(state: RunState, invocationID: string): number | undefined {
  const prefix = `${state.runID}:`

  if (!invocationID.startsWith(prefix)) {
    return undefined
  }

  const rest = invocationID.slice(prefix.length)

  return /^[1-9]\d*$/.test(rest) ? Number(rest) : undefined
}

function assertStack(state: RunState, maxDepth: number): void {
  if (state.frames.length > maxDepth) {
    invalidState('Run state exceeds the maximum frame depth.', ['frames'])
  }

  const last = topIndex(state)
  const seen = new Set<string>()

  state.frames.forEach((frame, index) => {
    if (index === 0 && frame.continuation) {
      invalidState('Root frame cannot have a continuation.', ['frames', 0, 'continuation'])
    }

    if (index > 0 && !frame.continuation) {
      invalidState('Non-root frame requires a continuation.', ['frames', index, 'continuation'])
    }

    const attemptKeys = Object.keys(frame.attempts)

    if (attemptKeys.length > 1 || (attemptKeys.length === 1 && attemptKeys[0] !== frame.node)) {
      invalidState('Retry attempts must belong to the active node.', ['frames', index, 'attempts'])
    }

    const attempts = Object.hasOwn(frame.attempts, frame.node)
      ? frame.attempts[frame.node]
      : undefined

    if (!attempts) {
      return
    }

    const path: IssuePath = ['frames', index, 'attempts', frame.node]

    if (index < last && attempts.retryAt !== undefined) {
      invalidState('Parked frame cannot have a scheduled retry.', [...path, 'retryAt'])
    }

    assertAttempts({ attempts, path, state, active: index === last })

    const invocation = invocationNumber(state, attempts.invocationID)

    if (invocation === undefined || invocation > state.invocation) {
      invalidState('Invocation ID is outside the run invocation range.', [...path, 'invocationID'])
    }

    if (seen.has(attempts.invocationID)) {
      invalidState('Invocation ID is shared by several attempts.', [...path, 'invocationID'])
    }

    seen.add(attempts.invocationID)
  })
}

/** Options for the definition-independent run state check. */
export type AssertRunStateShapeParams = {
  maxDepth: number
  /** Compiles `pending.schema`; a graph passes its validator cache so the resume reuses it. */
  validatorFor?: (schema: Schema) => Validator<unknown>
}

/** Assert the schema and definition-independent invariants of persisted run state. */
export function assertRunStateShape(
  value: unknown,
  params: AssertRunStateShapeParams,
): asserts value is RunState {
  if (!isJSONValue(value)) {
    invalidState('Run state must be a JSON value.', [])
  }

  const result = validate(value)

  if (result instanceof ValidationError) {
    throw new FlowStateError({ issues: result.issues })
  }

  const state = value as unknown as RunState

  assertStack(state, params.maxDepth)

  const frame = top(state)
  const attempts = Object.hasOwn(frame.attempts, frame.node)
    ? frame.attempts[frame.node]
    : undefined

  if (
    state.inFlight &&
    (!attempts ||
      state.inFlight.node !== frame.node ||
      state.inFlight.attempt !== attempts.count ||
      state.inFlight.attempt < 1 ||
      state.inFlight.invocationID !== attempts.invocationID)
  ) {
    invalidState('In-flight attempt does not match active node.', ['inFlight'])
  }

  if (
    state.pending &&
    (state.pending.node !== frame.node ||
      (state.pending.deadline && !isCanonicalTimestamp(state.pending.deadline)) ||
      (state.pending.resumeAt && !isCanonicalTimestamp(state.pending.resumeAt)))
  ) {
    invalidState('Pending work does not match active node or time format.', ['pending'])
  }

  if (state.pending?.schema) {
    try {
      const compile = params.validatorFor ?? ((schema: Schema) => createValidator(schema))

      compile(state.pending.schema)
    } catch {
      invalidState('Pending schema cannot be compiled.', ['pending', 'schema'])
    }
  }

  assertStatus(state, frame.node, attempts)
}

/** Parameters for checking run state frames against their resolved definitions. */
export type AssertRunStateDefinitionsParams = {
  state: RunState
  definitions: Array<FlowDefinition>
  kinds: Map<string, NodeKind>
}

/** Assert that each frame of shape-checked run state fits its definition (`definitions[i]` for `frames[i]`). */
export function assertRunStateDefinitions(params: AssertRunStateDefinitionsParams): void {
  const { state, definitions, kinds } = params
  const last = topIndex(state)

  if (definitions.length !== state.frames.length) {
    invalidState('Resolved definitions do not match the frame stack.', ['frames'])
  }

  state.frames.forEach((frame, index) => {
    const definition = definitions[index]

    if (!definition) {
      invalidState('Frame has no resolved definition.', ['frames', index])
    }

    const node = Object.hasOwn(definition.nodes, frame.node)
      ? definition.nodes[frame.node]
      : undefined

    if (!node) {
      invalidState('Active frame node is missing from definition.', ['frames', index, 'node'])
    }

    if (Object.hasOwn(frame.attempts, frame.node) && !kinds.get(node.kind)?.retries) {
      invalidState('Node kind does not support retries.', ['frames', index, 'attempts', frame.node])
    }

    for (const [nodeID, count] of Object.entries(frame.loops)) {
      const loop = Object.hasOwn(definition.nodes, nodeID) ? definition.nodes[nodeID] : undefined

      if (loop?.kind !== 'loop' || count < 0 || count > (loop.maxIterations as number)) {
        invalidState('Loop count is invalid for its node.', ['frames', index, 'loops', nodeID])
      }
    }

    if (index === last) {
      return
    }

    const continuation = state.frames[index + 1]?.continuation

    const parked =
      continuation?.callerNode === frame.node &&
      ((continuation.kind === 'call' && node.kind === 'call') ||
        (continuation.kind === 'loopBody' &&
          node.kind === 'loop' &&
          typeof node.body === 'object' &&
          node.body !== null))

    if (!parked) {
      invalidState('Parked frame node does not match the continuation above it.', [
        'frames',
        index,
        'node',
      ])
    }

    // The continuation must be the one the caller node pushes: a `call` returns to its `next`
    // and fails over to its `onError`; a flow-body loop re-enters itself and has no `onError`.
    const expected =
      continuation.kind === 'call'
        ? { returnTo: node.next, onError: node.onError }
        : { returnTo: frame.node, onError: undefined }

    if (continuation.returnTo !== expected.returnTo || continuation.onError !== expected.onError) {
      invalidState('Continuation does not match its caller node.', [
        'frames',
        index + 1,
        'continuation',
      ])
    }
  })
}

/** Parameters for a full run state check. */
export type AssertRunStateParams = {
  definitions: Array<FlowDefinition>
  kinds: Map<string, NodeKind>
  maxDepth?: number
}

/** Assert the schema, stack and cross-field invariants of persisted run state against its definitions. */
export function assertRunState(
  value: unknown,
  params: AssertRunStateParams,
): asserts value is RunState {
  assertRunStateShape(value, { maxDepth: params.maxDepth ?? defaultMaxDepth })
  assertRunStateDefinitions({ state: value, definitions: params.definitions, kinds: params.kinds })
}
