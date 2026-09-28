import { assertRetryPolicy } from '@sozai/async'
import { isJSONValue } from '@sozai/json'
import { createValidator, ValidationError } from '@sozai/schema'

import { FlowStateError } from './errors.js'
import { runStateSchema } from './schemas.js'
import { isCanonicalTimestamp } from './time.js'
import type { FlowDefinition, Frame, NodeAttempts, NodeKind, RunState } from './types.js'

const validate = createValidator(runStateSchema, { strict: false })

type IssuePath = Array<string | number>

type AssertAttemptsParams = {
  attempts: NodeAttempts
  frame: Frame
  state: RunState
  retries: boolean
}

function invalidState(message: string, path: IssuePath): never {
  throw new FlowStateError({ issues: [{ message, path }] })
}

function assertAttempts(params: AssertAttemptsParams): void {
  const { attempts, frame, state, retries } = params
  const path: IssuePath = ['frames', 0, 'attempts', frame.node]

  if (!retries) {
    invalidState('Node kind does not support retries.', path)
  }

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
    (attempts.interruptions !== 0 || attempts.lastFailure || attempts.retryAt || state.inFlight)
  ) {
    invalidState('Initial retry attempt has conflicting progress.', path)
  }

  if (attempts.deadline && !isCanonicalTimestamp(attempts.deadline)) {
    invalidState('Retry deadline must be a canonical UTC timestamp.', [...path, 'deadline'])
  }

  if (attempts.retryAt && !isCanonicalTimestamp(attempts.retryAt)) {
    invalidState('Retry time must be a canonical UTC timestamp.', [...path, 'retryAt'])
  }

  if (attempts.retryAt && (attempts.count < 1 || state.inFlight)) {
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
      0,
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

/** Assert the schema and cross-field invariants of persisted run state. */
export function assertRunState(
  value: unknown,
  definition: FlowDefinition,
  kinds: Map<string, NodeKind>,
): asserts value is RunState {
  if (!isJSONValue(value)) {
    invalidState('Run state must be a JSON value.', [])
  }

  const result = validate(value)

  if (result instanceof ValidationError) {
    throw new FlowStateError({ issues: result.issues })
  }

  const state = value as unknown as RunState

  if (state.frames.length !== 1) {
    invalidState('Run state requires exactly one frame.', ['frames'])
  }

  const frame = state.frames[0]

  if (!frame) {
    invalidState('Run state requires an active frame.', ['frames', 0])
  }

  const node = Object.hasOwn(definition.nodes, frame.node)
    ? definition.nodes[frame.node]
    : undefined

  if (!node) {
    invalidState('Active frame node is missing from definition.', ['frames', 0, 'node'])
  }

  if (frame.continuation) {
    invalidState('Active frame cannot have a continuation.', ['frames', 0, 'continuation'])
  }

  const attemptKeys = Object.keys(frame.attempts)

  if (attemptKeys.length > 1 || (attemptKeys.length === 1 && attemptKeys[0] !== frame.node)) {
    invalidState('Retry attempts must belong to the active node.', ['frames', 0, 'attempts'])
  }

  const attempts = Object.hasOwn(frame.attempts, frame.node)
    ? frame.attempts[frame.node]
    : undefined

  if (attempts) {
    assertAttempts({ attempts, frame, state, retries: Boolean(kinds.get(node.kind)?.retries) })
  }

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

  for (const [nodeID, count] of Object.entries(frame.loops)) {
    const loop = Object.hasOwn(definition.nodes, nodeID) ? definition.nodes[nodeID] : undefined

    if (loop?.kind !== 'loop' || count < 0 || count > (loop.maxIterations as number)) {
      invalidState('Loop count is invalid for its node.', ['frames', 0, 'loops', nodeID])
    }
  }

  if (
    state.pending &&
    (state.pending.node !== frame.node ||
      (state.pending.deadline && !isCanonicalTimestamp(state.pending.deadline)) ||
      (state.pending.resumeAt && !isCanonicalTimestamp(state.pending.resumeAt)))
  ) {
    invalidState('Pending work does not match active node or time format.', ['pending'])
  }

  assertStatus(state, frame.node, attempts)
}
