import { assertRetryPolicy } from '@sozai/async'
import { isJSONValue } from '@sozai/json'
import { createValidator, ValidationError } from '@sozai/schema'

import { FlowStateError } from './errors.js'
import { runStateSchema } from './schemas.js'
import { isCanonicalTimestamp } from './time.js'
import type { FlowDefinition, NodeKind, RunState } from './types.js'

const validate = createValidator(runStateSchema, { strict: false })
export function assertRunState(
  value: unknown,
  definition: FlowDefinition,
  kinds: Map<string, NodeKind>,
): asserts value is RunState {
  if (!isJSONValue(value) || validate(value) instanceof ValidationError) throw new FlowStateError()
  const state = value as unknown as RunState
  if (state.frames.length !== 1) throw new FlowStateError()
  const frame = state.frames[0]
  if (!frame) throw new FlowStateError()
  const node = Object.hasOwn(definition.nodes, frame.node)
    ? definition.nodes[frame.node]
    : undefined
  if (!node || frame.continuation) throw new FlowStateError()
  const attemptKeys = Object.keys(frame.attempts)
  if (attemptKeys.length > 1 || (attemptKeys.length === 1 && attemptKeys[0] !== frame.node))
    throw new FlowStateError()
  const attempts = Object.hasOwn(frame.attempts, frame.node)
    ? frame.attempts[frame.node]
    : undefined
  if (attempts) {
    if (!kinds.get(node.kind)?.retries) throw new FlowStateError()
    try {
      assertRetryPolicy(attempts.policy)
    } catch {
      // biome-ignore lint/style/useErrorCause: persisted state errors expose no source details
      throw new FlowStateError()
    }
    if (
      attempts.policy.suspendAfterMs !== undefined &&
      attempts.policy.totalTimeoutMs !== undefined &&
      attempts.policy.suspendAfterMs >= attempts.policy.totalTimeoutMs
    )
      throw new FlowStateError()
    if (
      attempts.count < 0 ||
      attempts.count > attempts.policy.maxAttempts ||
      attempts.interruptions > (attempts.policy.maxInterruptions ?? 3)
    )
      throw new FlowStateError()
    if (
      attempts.count === 0 &&
      (attempts.interruptions !== 0 || attempts.lastFailure || attempts.retryAt || state.inFlight)
    )
      throw new FlowStateError()
    if (
      (attempts.deadline && !isCanonicalTimestamp(attempts.deadline)) ||
      (attempts.retryAt && !isCanonicalTimestamp(attempts.retryAt))
    )
      throw new FlowStateError()
    if (attempts.retryAt && (attempts.count < 1 || state.inFlight)) throw new FlowStateError()
  }
  if (
    state.inFlight &&
    (!attempts ||
      state.inFlight.node !== frame.node ||
      state.inFlight.attempt !== attempts.count ||
      state.inFlight.attempt < 1 ||
      state.inFlight.invocationID !== attempts.invocationID)
  )
    throw new FlowStateError()
  for (const [id, count] of Object.entries(frame.loops)) {
    const loop = Object.hasOwn(definition.nodes, id) ? definition.nodes[id] : undefined
    if (loop?.kind !== 'loop' || count < 0 || count > (loop.maxIterations as number))
      throw new FlowStateError()
  }
  if (
    state.pending &&
    (state.pending.node !== frame.node ||
      (state.pending.deadline && !isCanonicalTimestamp(state.pending.deadline)) ||
      (state.pending.resumeAt && !isCanonicalTimestamp(state.pending.resumeAt)))
  )
    throw new FlowStateError()
  const terminal =
    state.status === 'ended' || state.status === 'error' || state.status === 'aborted'
  if (terminal && (state.pending || state.inFlight || attempts?.retryAt)) throw new FlowStateError()
  if (
    state.status === 'running' &&
    (state.pending ||
      state.outcome !== undefined ||
      state.output !== undefined ||
      state.error !== undefined ||
      (attempts?.retryAt && state.inFlight))
  )
    throw new FlowStateError()
  if (
    state.status === 'suspended' &&
    (!state.pending ||
      state.inFlight ||
      state.outcome !== undefined ||
      state.output !== undefined ||
      state.error !== undefined)
  )
    throw new FlowStateError()
  if (
    state.pending?.reason === 'retry' &&
    (!attempts?.retryAt ||
      attempts.retryAt !== state.pending.resumeAt ||
      state.pending.deadline !== undefined ||
      state.pending.schema !== undefined ||
      state.pending.data !== undefined ||
      state.pending.prompt !== undefined)
  )
    throw new FlowStateError()
  if (state.pending?.reason === 'suspend' && (attempts?.retryAt || state.pending.resumeAt))
    throw new FlowStateError()
  if ((state.status === 'error' && !state.error) || (state.status !== 'error' && state.error))
    throw new FlowStateError()
  if (state.status !== 'ended' && (state.outcome !== undefined || state.output !== undefined))
    throw new FlowStateError()
}
