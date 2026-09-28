import { getRetryDelay, TimeoutInterruption } from '@sozai/async'
import { SpanStatusCode } from '@sozai/otel'

import { FlowNodeFailure } from './kinds.js'
import type { FlowRunner } from './run.js'
import { clone, required, retryFailureReason, sanitize } from './run-utils.js'
import { toTimestamp } from './time.js'
import type {
  ErrorMetadata,
  FlowNode,
  NodeAttempts,
  NodeKind,
  RunError,
  RunState,
} from './types.js'

export type FailureParams = {
  code: string
  nodeID: string
  detail?: Partial<RunError>
  meta?: ErrorMetadata
}

export type NodeFailParams = {
  nodeID: string
  node: FlowNode
  kind: NodeKind
  reason: RunError['reason']
  meta: ErrorMetadata
}

export type HandleNodeErrorParams = {
  error: unknown
  nodeID: string
  node: FlowNode
  kind: NodeKind
  resumed: boolean
}

type RetryDecisionParams = {
  error: unknown
  kind: NodeKind
  attempt: NodeAttempts
  meta: ErrorMetadata
  now: () => number
  random?: () => number
}

type RetryDecision = {
  delayMs: number
  retryAt: number
  terminalReason?: RunError['reason']
}

type ScheduleRetryParams = {
  runner: FlowRunner
  nodeID: string
  kind: NodeKind
  attempt: NodeAttempts
  meta: ErrorMetadata
  decision: RetryDecision
}

export function failRun(runner: FlowRunner, params: FailureParams): RunState {
  const { code, nodeID, detail, meta } = params
  const next = clone(runner.state)

  next.status = 'error'
  delete next.inFlight
  delete next.pending

  const attempts =
    next.frames[0] && Object.hasOwn(next.frames[0].attempts, nodeID)
      ? next.frames[0].attempts[nodeID]
      : undefined

  if (attempts) {
    delete attempts.retryAt
  }

  if (code === 'loop_exhausted') {
    delete next.frames[0]?.loops[nodeID]
  }

  next.error = {
    code,
    name: code === 'node_failed' ? 'FlowNodeFailure' : 'FlowRunError',
    node: nodeID,
    ...detail,
    ...(meta ? { lastFailure: meta } : {}),
  }

  const saved = runner.commit(next, false)

  runner.closeFailedSpan((span) => {
    if (span) {
      span.setStatus({ code: SpanStatusCode.ERROR })
      span.setAttribute('flow.error.code', code)

      if (meta) {
        span.setAttribute('error.type', meta.type)
      }
    }

    runner.logError('Flow run failed', {
      'flow.id': runner.definition.id,
      runID: saved.runID,
      code,
      node: nodeID,
      ...(detail?.reason ? { reason: detail.reason } : {}),
      ...(detail?.attempts !== undefined ? { attempts: detail.attempts } : {}),
      ...(meta ?? {}),
    })
  })

  runner.segment.setStatus({ code: SpanStatusCode.ERROR })
  runner.segment.setAttribute('flow.error.code', code)

  if (meta) {
    runner.segment.setAttribute('error.type', meta.type)
  }

  runner.status(saved)

  return saved
}

export function failNode(runner: FlowRunner, params: NodeFailParams): RunState {
  const { nodeID, node, kind, reason, meta } = params

  const attempts =
    runner.state.frames[0] && Object.hasOwn(runner.state.frames[0].attempts, nodeID)
      ? runner.state.frames[0].attempts[nodeID]
      : undefined

  const count = attempts?.count ?? 1

  if (typeof node.onError === 'string') {
    return routeToOnError({ runner, nodeID, kind, reason, meta, count, target: node.onError })
  }

  return runner.failure({ code: 'node_failed', nodeID, detail: { reason, attempts: count }, meta })
}

function routeToOnError(
  params: Omit<NodeFailParams, 'node'> & { runner: FlowRunner; count: number; target: string },
): RunState {
  const { runner, nodeID, kind, reason, meta, count, target } = params
  const next = clone(runner.state)
  const frame = required(next.frames[0], ['frames', 0])

  frame.results[nodeID] = {
    error: {
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

  const saved = runner.commit(next)

  runner.closeFailedSpan((span) => {
    span?.addEvent('flow.error.handled', { 'error.type': meta.type })

    runner.warn('Flow node failure handled', {
      'flow.id': runner.definition.id,
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

function classifyRetry(params: RetryDecisionParams): RetryDecision {
  const { error, kind, attempt, meta, now, random } = params
  const expired =
    (error instanceof TimeoutInterruption && error.cause === 'deadline') ||
    (!!attempt.deadline && now() >= new Date(attempt.deadline).getTime())

  let decision: ReturnType<NonNullable<NodeKind['retryable']>> = false

  try {
    decision =
      error instanceof TimeoutInterruption && error.cause === 'attempt'
        ? true
        : (kind.retryable?.(error) ?? false)
  } catch {
    decision = false
  }

  const reason = retryFailureReason(expired, decision, attempt)

  const delayMs = reason
    ? 0
    : getRetryDelay(attempt.policy, attempt.count, {
        afterMs: typeof decision === 'object' ? decision.afterMs : meta.retryAfterMs,
        random,
      })

  const retryAt = now() + delayMs

  const terminalReason =
    reason ??
    (attempt.deadline && retryAt >= new Date(attempt.deadline).getTime()
      ? 'total_timeout'
      : undefined)

  return { delayMs, retryAt, terminalReason }
}

export function handleNodeError(runner: FlowRunner, params: HandleNodeErrorParams): RunState {
  const { error, nodeID, node, kind, resumed } = params

  if (!kind.retries && !resumed) {
    const entered = clone(runner.state)

    entered.steps++

    required(entered.frames[0], ['frames', 0]).invocation++

    runner.replaceState(entered)
  }

  const meta = sanitize(error, kind)

  if (
    error instanceof FlowNodeFailure &&
    ['invalid_value', 'invalid_target', 'invalid_suspend', 'loop_exhausted'].includes(error.code)
  ) {
    return runner.failure({ code: error.code, nodeID, meta })
  }

  const frame = required(runner.state.frames[0], ['frames', 0])
  const attempt = Object.hasOwn(frame.attempts, nodeID) ? frame.attempts[nodeID] : undefined

  if (!attempt) {
    return runner.nodeFail({ nodeID, node, kind, reason: 'non_retryable', meta })
  }

  const decision = classifyRetry({
    error,
    kind,
    attempt,
    meta,
    now: runner.now,
    random: runner.options.random,
  })

  if (decision.terminalReason) {
    const next = clone(runner.state)

    required(required(next.frames[0], ['frames', 0]).attempts[nodeID], [
      'frames',
      0,
      'attempts',
      nodeID,
    ]).lastFailure = meta

    delete next.inFlight

    runner.replaceState(next)

    return runner.nodeFail({ nodeID, node, kind, reason: decision.terminalReason, meta })
  }

  return scheduleRetry({ runner, nodeID, kind, attempt, meta, decision })
}

function scheduleRetry(params: ScheduleRetryParams): RunState {
  const { runner, nodeID, kind, attempt, meta, decision } = params
  const { delayMs, retryAt } = decision
  const suspended =
    attempt.policy.suspendAfterMs !== undefined && delayMs > attempt.policy.suspendAfterMs

  const next = clone(runner.state)

  const updated = required(required(next.frames[0], ['frames', 0]).attempts[nodeID], [
    'frames',
    0,
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

  const saved = runner.commit(next, false)

  runner.closeFailedSpan((span) => {
    span?.addEvent('flow.retry', {
      'flow.retry.delay_ms': delayMs,
      'flow.retry.suspended': suspended,
      'error.type': meta.type,
    })

    runner.warn('Flow node retry scheduled', {
      'flow.id': runner.definition.id,
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
