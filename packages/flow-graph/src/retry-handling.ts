import { getRetryDelay, TimeoutInterruption } from '@sozai/async'
import { SpanStatusCode } from '@sozai/otel'

import { FlowNodeFailure } from './errors.js'
import { nextInvocationID, top, topIndex } from './frames.js'
import type { RetryDecision } from './retry-commits.js'
import { callError, retryTiming, routeToOnError, scheduleRetry } from './retry-commits.js'
import type { FlowRunner } from './run.js'
import { clone, required, retryFailureReason, sanitize } from './run-utils.js'
import type {
  ErrorMetadata,
  FlowNode,
  NodeAttempts,
  NodeKind,
  RunError,
  RunState,
} from './types.js'
import { unwindFailure } from './unwind.js'

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
  /** The failure stops a retry scheduled by a callee failure; a `call` records `FlowCallError`. */
  calleeRetry?: boolean
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

/** Reference failures of a `call`, `goto` or flow-body loop node; never retried. */
const referenceFailureCodes = ['missing_flow', 'invalid_flow', 'max_depth', 'invalid_input']

/** Whether a node references another flow: a `call`, a `goto` or a loop with a flow body. */
const isReferenceNode = (node: FlowNode): boolean =>
  node.kind === 'call' ||
  node.kind === 'goto' ||
  (node.kind === 'loop' && typeof node.body === 'object' && node.body !== null)

export function failRun(runner: FlowRunner, params: FailureParams): RunState {
  const { code, nodeID, detail, meta } = params

  if (topIndex(runner.state) > 0) {
    // A caller frame may handle the failure; otherwise the stack stays intact.
    const handled = unwindFailure({ runner, code, reason: detail?.reason, meta })

    if (handled) {
      return handled
    }
  }

  const next = clone(runner.state)

  next.status = 'error'
  delete next.inFlight
  delete next.pending

  const frame = top(next)
  const attempts = Object.hasOwn(frame.attempts, nodeID) ? frame.attempts[nodeID] : undefined

  if (attempts) {
    delete attempts.retryAt
  }

  if (code === 'loop_exhausted') {
    delete frame.loops[nodeID]
  }

  next.error = {
    code,
    name: code === 'node_failed' ? 'FlowNodeFailure' : 'FlowRunError',
    node: nodeID,
    ...detail,
    ...(meta ? { lastFailure: meta } : {}),
    flow: frame.flow.id,
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
      'flow.id': frame.flow.id,
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
  const { nodeID, node, kind, reason, meta, calleeRetry } = params

  const frame = top(runner.state)
  const attempts = Object.hasOwn(frame.attempts, nodeID) ? frame.attempts[nodeID] : undefined

  const count = attempts?.count ?? 1

  if (typeof node.onError === 'string') {
    return routeToOnError({
      runner,
      nodeID,
      kind,
      reason,
      meta,
      count,
      target: node.onError,
      // A call's own failures keep the default shape; a stopped callee retry is a FlowCallError.
      ...(calleeRetry && kind.kind === 'call'
        ? { handled: callError({ code: 'node_failed', reason, attempts: count }) }
        : {}),
    })
  }

  return runner.failure({ code: 'node_failed', nodeID, detail: { reason, attempts: count }, meta })
}

function classifyRetry(params: RetryDecisionParams): RetryDecision {
  const { error, kind, attempt, meta, now, random } = params
  const expired =
    (error instanceof TimeoutInterruption && error.cause === 'deadline') ||
    retryTiming({ deadline: attempt.deadline, now: now() }).expired

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

  const timing = retryTiming({ deadline: attempt.deadline, now: now(), delayMs })
  const terminalReason = reason ?? (timing.expired ? 'total_timeout' : undefined)

  return { delayMs, retryAt: timing.retryAt, terminalReason }
}

export function handleNodeError(runner: FlowRunner, params: HandleNodeErrorParams): RunState {
  const { error, nodeID, node, kind, resumed } = params

  if (!kind.retries && !resumed) {
    const entered = clone(runner.state)

    entered.steps++

    nextInvocationID(entered)

    runner.replaceState(entered)
  }

  const meta = sanitize(error, kind)

  if (
    error instanceof FlowNodeFailure &&
    ['invalid_value', 'invalid_target', 'invalid_suspend', 'loop_exhausted'].includes(error.code)
  ) {
    return runner.failure({ code: error.code, nodeID, meta })
  }

  const frame = top(runner.state)
  const attempt = Object.hasOwn(frame.attempts, nodeID) ? frame.attempts[nodeID] : undefined

  // Only reference nodes raise reference failures; from any other kind they are ordinary failures.
  if (
    error instanceof FlowNodeFailure &&
    referenceFailureCodes.includes(error.code) &&
    isReferenceNode(node)
  ) {
    return failReference({ runner, code: error.code, nodeID, node, kind, meta, attempt })
  }

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

    required(top(next).attempts[nodeID], [
      'frames',
      topIndex(next),
      'attempts',
      nodeID,
    ]).lastFailure = meta

    delete next.inFlight

    runner.replaceState(next)

    return runner.nodeFail({ nodeID, node, kind, reason: decision.terminalReason, meta })
  }

  return scheduleRetry({ runner, nodeID, kind, attempt, meta, decision })
}

function failReference(params: {
  runner: FlowRunner
  code: string
  nodeID: string
  node: FlowNode
  kind: NodeKind
  meta: ErrorMetadata
  attempt?: NodeAttempts
}): RunState {
  const { runner, code, nodeID, node, kind, attempt } = params
  const meta = { ...params.meta, code: params.meta.code ?? code }
  const count = attempt?.count ?? 1

  if (typeof node.onError === 'string') {
    return routeToOnError({
      runner,
      nodeID,
      kind,
      reason: 'non_retryable',
      meta,
      count,
      target: node.onError,
    })
  }

  return runner.failure({
    code,
    nodeID,
    detail: { reason: 'non_retryable', attempts: count },
    meta,
  })
}
