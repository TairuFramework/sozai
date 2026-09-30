import { getRetryDelay } from '@sozai/async'
import type { JSONValue } from '@sozai/json'

import { top, topIndex } from './frames.js'
import type { UnwoundState } from './retry-commits.js'
import { callError, retryTiming, routeToOnError, scheduleRetry } from './retry-commits.js'
import type { FlowRunner } from './run.js'
import { clone, own, required } from './run-utils.js'
import type { ErrorMetadata, RunError, RunState } from './types.js'

/** Callee return value handed back to the caller frame. */
export type PopFrameParams = {
  runner: FlowRunner
  /** Uncommitted working state to pop from (mutated); defaults to a copy of the runner state. */
  state?: RunState
  output: Record<string, JSONValue>
  outcome?: string
}

/**
 * Pop the completed top frame in one commit: the caller receives `{ output, outcome? }` as the
 * result of its call node, drops that node's attempts and moves to the continuation's `returnTo`.
 */
export function popFrame(params: PopFrameParams): RunState {
  const { runner, output, outcome } = params
  const next = params.state ?? clone(runner.state)
  const index = topIndex(next)
  const callee = next.frames.pop()
  const continuation = required(callee?.continuation, ['frames', index, 'continuation'])
  const caller = top(next)

  caller.results[continuation.callerNode] = {
    output,
    ...(outcome !== undefined ? { outcome } : {}),
  }
  delete caller.attempts[continuation.callerNode]
  caller.node = continuation.returnTo

  delete next.inFlight
  delete next.pending
  next.status = 'running'

  runner.replaceDefinitions(runner.definitions.slice(0, index))

  const saved = runner.commit(next)

  runner.events.fire('node:exit', { node: continuation.callerNode, runState: saved })

  return saved
}

/** Failure codes that callers may handle; every other code ends the run with the stack intact. */
const walkCodes = [
  'node_failed',
  'loop_exhausted',
  'missing_flow',
  'invalid_flow',
  'max_depth',
  'invalid_input',
]

/** Failure of the top frame's node, as it would be recorded in `RunError`. */
export type UnwindFailureParams = {
  runner: FlowRunner
  code: string
  reason?: RunError['reason']
  meta?: ErrorMetadata
}

/** Working copy of the runner state with every frame above `index` removed. */
function unwindTo(runner: FlowRunner, index: number): UnwoundState {
  const state = clone(runner.state)

  state.frames.splice(index + 1)

  delete state.inFlight
  delete state.pending

  return { state, definitions: runner.definitions.slice(0, index + 1) }
}

/**
 * Walk the frames below a failing non-root frame and let the first handling caller node take the
 * failure: a `call` with attempts left schedules a retry that re-pushes the callee, otherwise a
 * caller with `onError` routes there with a `FlowCallError` result. The frames above the handling
 * caller are removed in the same commit. Returns `undefined`, committing nothing, when no caller
 * handles the failure.
 */
export function unwindFailure(params: UnwindFailureParams): RunState | undefined {
  const { runner, code, reason, meta } = params
  const state = runner.state

  if (!walkCodes.includes(code)) {
    return undefined
  }

  const retryable = code === 'node_failed' && reason !== 'non_retryable'
  const now = runner.now()
  const kind = required(runner.kinds.get('call'), ['frames', topIndex(state), 'node'])

  for (let index = topIndex(state) - 1; index >= 0; index--) {
    const continuation = required(state.frames[index + 1]?.continuation, [
      'frames',
      index + 1,
      'continuation',
    ])

    const callerNode = continuation.callerNode
    const attempt = own(required(state.frames[index], ['frames', index]).attempts, callerNode)
    let callerReason = reason

    if (continuation.kind === 'call' && attempt && retryable) {
      // On `call`, totalTimeoutMs is a retry deadline: no attempt starts once it has passed.
      const { deadline } = attempt

      if (!retryTiming({ deadline, now }).expired) {
        if (attempt.count < attempt.policy.maxAttempts) {
          const delayMs = getRetryDelay(attempt.policy, attempt.count, {
            afterMs: meta?.retryAfterMs,
            random: runner.options.random,
          })

          const { retryAt, expired } = retryTiming({ deadline, now, delayMs })

          if (!expired) {
            return scheduleRetry({
              runner,
              nodeID: callerNode,
              kind,
              attempt,
              meta: meta ?? { type: 'Error' },
              decision: { delayMs, retryAt },
              unwound: unwindTo(runner, index),
            })
          }

          callerReason = 'total_timeout'
        }
      } else {
        callerReason = 'total_timeout'
      }
    }

    if (continuation.onError) {
      const count = attempt?.count ?? 1

      return routeToOnError({
        runner,
        nodeID: callerNode,
        kind,
        reason: callerReason,
        meta: meta ?? { type: 'Error' },
        count,
        target: continuation.onError,
        handled: callError({ code, reason: callerReason, attempts: count }),
        unwound: unwindTo(runner, index),
      })
    }
  }

  return undefined
}
