import { raceAttempt } from '@sozai/async'
import type { JSONValue } from '@sozai/json'
import { setSpanOnContext, withActiveContext } from '@sozai/otel'

import { evaluateFilter } from './filter.js'
import { FlowNodeFailure } from './kinds.js'
import type { FlowRunner } from './run.js'
import { clone, defaultMeta, required, requireJSON, tracer } from './run-utils.js'
import { isCanonicalTimestamp } from './time.js'
import type { ExecuteContext, NodeKind, NodeResult, ResumeEvent, RunState } from './types.js'
import type { Scope } from './value.js'
import { resolveValue } from './value.js'

export type RunOneParams = {
  nodeID: string
  kind: NodeKind
  attempt: number
  invocationID: string
  pending?: RunState['pending']
  deadline?: number
  timeoutMs?: number
}

type NodeExecutorParams = { runner: FlowRunner }

export class NodeExecutor {
  #runner: FlowRunner

  constructor(params: NodeExecutorParams) {
    this.#runner = params.runner
  }

  async runOne(params: RunOneParams): Promise<{ result: NodeResult; staged: Scope }> {
    const { nodeID, kind, attempt, invocationID, pending, deadline, timeoutMs } = params

    const frame = required(this.#runner.state.frames[0], ['frames', 0])

    const staged: Scope = {
      input: clone(frame.input),
      state: clone(frame.state),
      results: clone(frame.results),
      loops: clone(frame.loops),
    }

    const nodeSpan = tracer.startSpan(
      'flow.node',
      {
        attributes: {
          'flow.node.id': nodeID,
          'flow.node.kind': kind.kind,
          'flow.attempt': attempt,
        },
      },
      this.#runner.segmentContext,
    )

    const nodeContext = setSpanOnContext(this.#runner.segmentContext, nodeSpan)
    let thrown: unknown

    try {
      const execute = async (attemptSignal: AbortSignal) => {
        return withActiveContext(nodeContext, async () => {
          const context: ExecuteContext = {
            nodeID,
            runID: this.#runner.state.runID,
            invocationID,
            attempt,
            ...(pending?.data !== undefined ? { pending: { data: pending.data } } : {}),
            scope: staged,
            resolve: (value) => resolveValue(value, staged),
            evaluate: (filter) => evaluateFilter(filter, staged),
            setResult: (value) => {
              staged.results[nodeID] = value
            },
            signal: attemptSignal,
            span: nodeSpan,
            logger: this.#runner.logger,
            runtime: this.#runner.runtime,
          }

          if (this.#runner.runSignal.aborted) {
            throw this.#runner.runSignal.reason
          }

          const node = required(
            Object.hasOwn(this.#runner.definition.nodes, nodeID)
              ? this.#runner.definition.nodes[nodeID]
              : undefined,
            ['frames', 0, 'node'],
          )

          const resumeEvent =
            this.#runner.mode === 'resume' && this.#runner.state.pending?.reason === 'suspend'
              ? (this.#runner.event as ResumeEvent | undefined)
              : undefined

          if (resumeEvent && !kind.resume) {
            throw new FlowNodeFailure({ code: 'invalid_suspend' })
          }

          const result = resumeEvent
            ? await required(kind.resume, ['pending'])(node, context, resumeEvent)
            : await kind.execute(node, context)

          if (this.#runner.runSignal.aborted) {
            throw this.#runner.runSignal.reason
          }

          if (!result) {
            throw new FlowNodeFailure({ code: 'invalid_value' })
          }

          return result
        })
      }

      const result = kind.retries
        ? await raceAttempt({
            fn: execute,
            signal: this.#runner.signal,
            timeoutMs,
            deadline,
            now: this.#runner.now,
          })
        : await execute(this.#runner.runSignal)

      requireJSON(result)
      requireJSON(staged.state)
      requireJSON(staged.results)
      requireJSON(staged.loops)

      if ('suspend' in result) {
        if (
          !kind.resume ||
          (result.suspend.deadline && !isCanonicalTimestamp(result.suspend.deadline))
        ) {
          throw new FlowNodeFailure({ code: 'invalid_suspend' })
        }
      } else if ('next' in result) {
        if (
          !kind
            .targets(required(this.#runner.definition.nodes[nodeID], ['frames', 0, 'node']))
            .some((edge) => edge.id === result.next)
        ) {
          throw new FlowNodeFailure({ code: 'invalid_target' })
        }

        nodeSpan.setAttribute('flow.next', result.next)

        if ('result' in result) {
          requireJSON(result.result)

          staged.results[nodeID] = result.result as JSONValue
        }
      } else if (!('end' in result)) {
        throw new FlowNodeFailure({ code: 'invalid_value' })
      }

      requireJSON(staged)

      return { result, staged }
    } catch (error) {
      thrown = error

      this.#runner.setFailedSpan(nodeSpan)

      if (this.#runner.options.recordErrorMessages) {
        nodeSpan.recordException(error instanceof Error ? error : new Error(String(error)))
      }

      throw error
    } finally {
      if (thrown && !this.#runner.options.recordErrorMessages) {
        nodeSpan.setAttribute('error.type', defaultMeta(thrown).type)
      }

      if (!thrown) {
        nodeSpan.end()
      }
    }
  }
}
