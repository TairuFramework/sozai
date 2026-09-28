import { sleep } from '@sozai/async'

import type { FlowRunner } from './run.js'
import { clone, final, own, required } from './run-utils.js'
import { toTimestamp } from './time.js'
import type { FlowRetryPolicy, RunState } from './types.js'

export async function* driveRunner(runner: FlowRunner): AsyncGenerator<RunState, RunState> {
  let recovering = runner.mode === 'recover'

  try {
    while (runner.state.status === 'running' || runner.state.status === 'suspended') {
      if (runner.signal?.aborted) {
        yield runner.abort()
        break
      }

      const frame = required(runner.state.frames[0], ['frames', 0])
      const nodeID = frame.node

      const node = required(
        Object.hasOwn(runner.definition.nodes, nodeID)
          ? runner.definition.nodes[nodeID]
          : undefined,
        ['frames', 0, 'node'],
      )

      const kind = required(runner.kinds.get(node.kind), ['frames', 0, 'node'])
      const pending = runner.state.pending

      const attempts = Object.hasOwn(frame.attempts, nodeID) ? frame.attempts[nodeID] : undefined

      if (runner.state.status === 'suspended' && pending?.reason === 'suspend') {
        const invocationID = attempts?.invocationID ?? `${runner.state.runID}:0:${frame.invocation}`

        try {
          const { result, staged } = await runner.runOne({
            nodeID,
            kind,
            attempt: attempts?.count ?? 1,
            invocationID,
            pending,
            deadline: attempts?.deadline ? new Date(attempts.deadline).getTime() : undefined,
            timeoutMs: attempts?.policy.attemptTimeoutMs,
          })

          const saved = runner.applyResult({ result, staged, nodeID, resumed: true })

          yield saved

          if (final(saved.status)) {
            break
          }
        } catch (error) {
          if (runner.signal?.aborted) {
            yield runner.abort()
            break
          }

          const saved = runner.handleNodeError({ error, nodeID, node, kind, resumed: true })

          yield saved

          if (final(saved.status)) {
            break
          }
        }

        continue
      }

      if (attempts?.retryAt) {
        const remaining = new Date(attempts.retryAt).getTime() - runner.now()

        if (attempts.deadline && runner.now() >= new Date(attempts.deadline).getTime()) {
          yield runner.nodeFail({
            nodeID,
            node,
            kind,
            reason: 'total_timeout',
            meta: attempts.lastFailure ?? { type: 'TimeoutInterruption' },
          })

          if (final(runner.state.status)) {
            break
          }

          continue
        }

        if (
          recovering &&
          attempts.policy.suspendAfterMs !== undefined &&
          remaining > attempts.policy.suspendAfterMs
        ) {
          const next = clone(runner.state)

          next.status = 'suspended'
          next.pending = { node: nodeID, reason: 'retry', resumeAt: attempts.retryAt }

          const saved = runner.commit(next)

          runner.events.fire('suspend', { node: nodeID, runState: saved })

          yield saved
          break
        }

        recovering = false

        if (remaining > 0) {
          try {
            await sleep(remaining, runner.signal)
          } catch {
            if (runner.signal?.aborted) {
              yield runner.abort()
              break
            }
          }
        }

        if (runner.signal?.aborted) {
          yield runner.abort()
          break
        }
      }

      if (!attempts && runner.state.steps >= (runner.options.maxSteps ?? 1000)) {
        yield runner.failure({ code: 'max_steps', nodeID })
        break
      }

      if (kind.retries && !attempts) {
        const next = clone(runner.state)
        const frame = required(next.frames[0], ['frames', 0])

        const policy = clone(
          (node.retry as FlowRetryPolicy | undefined) ??
            (runner.options.retryDefaults
              ? own(runner.options.retryDefaults, kind.kind)
              : undefined) ?? {
              maxAttempts: 1,
            },
        )

        frame.invocation++

        next.steps++

        frame.attempts[nodeID] = {
          invocationID: `${runner.state.runID}:0:${frame.invocation}`,
          policy,
          count: 0,
          interruptions: 0,
          ...(policy.totalTimeoutMs !== undefined
            ? { deadline: toTimestamp(runner.now() + policy.totalTimeoutMs) }
            : {}),
        }

        const saved = runner.commit(next)

        runner.events.fire('node:enter', { node: nodeID, runState: saved })

        yield saved
        continue
      }

      const current =
        runner.state.frames[0] && Object.hasOwn(runner.state.frames[0].attempts, nodeID)
          ? runner.state.frames[0].attempts[nodeID]
          : undefined

      if (kind.retries && current) {
        if (current.deadline && runner.now() >= new Date(current.deadline).getTime()) {
          yield runner.nodeFail({
            nodeID,
            node,
            kind,
            reason: 'total_timeout',
            meta: current.lastFailure ?? { type: 'TimeoutInterruption' },
          })

          if (final(runner.state.status)) {
            break
          }

          continue
        }

        if (recovering && runner.state.inFlight) {
          if (current.interruptions >= (current.policy.maxInterruptions ?? 3)) {
            yield runner.nodeFail({
              nodeID,
              node,
              kind,
              reason: 'interrupted',
              meta: current.lastFailure ?? { type: 'Error' },
            })

            if (final(runner.state.status)) {
              break
            }

            continue
          }

          const next = clone(runner.state)

          required(required(next.frames[0], ['frames', 0]).attempts[nodeID], [
            'frames',
            0,
            'attempts',
            nodeID,
          ]).interruptions++

          yield runner.commit(next)
        } else {
          if (current.count >= current.policy.maxAttempts) {
            yield runner.nodeFail({
              nodeID,
              node,
              kind,
              reason: 'attempts',
              meta: current.lastFailure ?? { type: 'Error' },
            })

            if (final(runner.state.status)) {
              break
            }

            continue
          }

          const next = clone(runner.state)

          const attempt = required(required(next.frames[0], ['frames', 0]).attempts[nodeID], [
            'frames',
            0,
            'attempts',
            nodeID,
          ])

          attempt.count++
          attempt.interruptions = 0
          delete attempt.retryAt

          next.status = 'running'
          delete next.pending
          next.inFlight = {
            node: nodeID,
            attempt: attempt.count,
            invocationID: attempt.invocationID,
          }

          yield runner.commit(next)
        }

        recovering = false
      }

      const attempt =
        runner.state.frames[0] && Object.hasOwn(runner.state.frames[0].attempts, nodeID)
          ? runner.state.frames[0].attempts[nodeID]
          : undefined

      if (!kind.retries) {
        runner.events.fire('node:enter', { node: nodeID, runState: clone(runner.state) })
      }

      const invocationID =
        attempt?.invocationID ??
        `${runner.state.runID}:0:${(runner.state.frames[0]?.invocation ?? 0) + 1}`

      try {
        const { result, staged } = await runner.runOne({
          nodeID,
          kind,
          attempt: attempt?.count ?? 1,
          invocationID,
          deadline: attempt?.deadline ? new Date(attempt.deadline).getTime() : undefined,
          timeoutMs: attempt?.policy.attemptTimeoutMs,
        })

        const saved = runner.applyResult({ result, staged, nodeID, resumed: false })

        yield saved

        if (final(saved.status)) {
          break
        }
      } catch (error) {
        if (runner.signal?.aborted) {
          yield runner.abort()
          break
        }

        const saved = runner.handleNodeError({ error, nodeID, node, kind, resumed: false })

        yield saved

        if (final(saved.status)) {
          break
        }
      }
    }
  } finally {
    runner.status(runner.state)
  }

  return clone(runner.state)
}
