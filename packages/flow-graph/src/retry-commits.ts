import type { JSONValue } from '@sozai/json'

import { top, topIndex } from './frames.js'
import type { FlowRunner } from './run.js'
import { clone, required } from './run-utils.js'
import { toTimestamp } from './time.js'
import type {
  ErrorMetadata,
  FlowDefinition,
  NodeAttempts,
  NodeKind,
  RunError,
  RunState,
} from './types.js'

/** When the next attempt runs, or the reason no further attempt runs. */
export type RetryDecision = {
  delayMs: number
  retryAt: number
  terminalReason?: RunError['reason']
}

/** Uncommitted working state of an unwind and the definitions that match its frames. */
export type UnwoundState = {
  state: RunState
  definitions: Array<FlowDefinition>
}

/** Retry of the top frame's node to schedule from a decision. */
export type ScheduleRetryParams = {
  runner: FlowRunner
  nodeID: string
  kind: NodeKind
  attempt: NodeAttempts
  meta: ErrorMetadata
  decision: RetryDecision
  /** Working state whose top frame holds the node; defaults to a copy of the runner state. */
  unwound?: UnwoundState
}

/** Failed node routed to its `onError` target. */
export type RouteToOnErrorParams = {
  runner: FlowRunner
  nodeID: string
  kind: NodeKind
  reason: RunError['reason']
  meta: ErrorMetadata
  count: number
  target: string
  /** Handled error recorded as `results.<node>.error`; defaults to one built from `meta`. */
  handled?: Record<string, JSONValue>
  /** Working state whose top frame holds the node; defaults to a copy of the runner state. */
  unwound?: UnwoundState
}

/** Parameters for timing the next attempt of a retrying node against its total deadline. */
export type RetryTimingParams = {
  /** The attempt's total deadline (`NodeAttempts.deadline`), when its policy sets one. */
  deadline?: string
  now: number
  /** Delay before the next attempt; omitted to check whether the deadline has already passed. */
  delayMs?: number
}

/**
 * Time the next attempt: it starts at `now + delayMs`, and the deadline expires it when that time
 * reaches the deadline. Without a delay, this is whether the deadline has passed (`now >= deadline`).
 */
export function retryTiming(params: RetryTimingParams): { retryAt: number; expired: boolean } {
  const { deadline, now, delayMs = 0 } = params
  const retryAt = now + delayMs

  return {
    retryAt,
    expired: deadline !== undefined && retryAt >= new Date(deadline).getTime(),
  }
}

/** Handled error of a failed `call` node or of a callee failure handled by its caller. */
export const callError = (params: {
  code: string
  reason?: RunError['reason']
  attempts: number
}): Record<string, JSONValue> => ({
  type: 'FlowCallError',
  code: params.code,
  ...(params.reason ? { reason: params.reason } : {}),
  attempts: params.attempts,
})

/** Route a failed node to `target` in one commit, recording the handled error as its result. */
export function routeToOnError(params: RouteToOnErrorParams): RunState {
  const { runner, nodeID, kind, reason, meta, count, target, handled, unwound } = params
  const next = unwound?.state ?? clone(runner.state)
  const frame = top(next)

  frame.results[nodeID] = {
    error: handled ?? {
      type: meta.type,
      ...(meta.code ? { code: meta.code } : {}),
      ...(meta.status !== undefined ? { status: meta.status } : {}),
      reason: required(reason, ['error', 'reason']),
      attempts: count,
    },
  }
  frame.node = target
  delete frame.attempts[nodeID]

  delete next.inFlight
  delete next.pending
  next.status = 'running'

  if (unwound) {
    runner.replaceDefinitions(unwound.definitions)
  }

  const saved = runner.commit(next)

  runner.closeFailedSpan((span) => {
    span?.addEvent('flow.error.handled', { 'error.type': meta.type })

    runner.warn('Flow node failure handled', {
      'flow.id': frame.flow.id,
      runID: runner.state.runID,
      node: nodeID,
      kind: kind.kind,
      attempt: count,
      reason,
      ...meta,
    })
  })

  runner.events.fire('node:exit', { node: nodeID, runState: saved })

  return saved
}

/** Schedule the next attempt of the top frame's node in one commit, suspending on long delays. */
export function scheduleRetry(params: ScheduleRetryParams): RunState {
  const { runner, nodeID, kind, attempt, meta, decision, unwound } = params
  const { delayMs, retryAt } = decision
  const suspended =
    attempt.policy.suspendAfterMs !== undefined && delayMs > attempt.policy.suspendAfterMs

  const next = unwound?.state ?? clone(runner.state)

  const updated = required(top(next).attempts[nodeID], [
    'frames',
    topIndex(next),
    'attempts',
    nodeID,
  ])

  updated.lastFailure = meta
  updated.retryAt = toTimestamp(retryAt)

  delete next.inFlight
  delete next.pending
  next.status = suspended ? 'suspended' : 'running'

  if (suspended) {
    next.pending = { node: nodeID, reason: 'retry', resumeAt: updated.retryAt }
  }

  if (unwound) {
    runner.replaceDefinitions(unwound.definitions)
  }

  const saved = runner.commit(next, false)

  runner.closeFailedSpan((span) => {
    span?.addEvent('flow.retry', {
      'flow.retry.delay_ms': delayMs,
      'flow.retry.suspended': suspended,
      'error.type': meta.type,
    })

    runner.warn('Flow node retry scheduled', {
      'flow.id': top(next).flow.id,
      runID: saved.runID,
      node: nodeID,
      kind: kind.kind,
      attempt: attempt.count,
      delayMs,
      suspended,
      ...meta,
    })
  })

  runner.events.fire('retry', { node: nodeID, delayMs, runState: saved })

  if (suspended) {
    runner.events.fire('suspend', { node: nodeID, runState: saved })

    runner.status(saved)
  }

  return saved
}
