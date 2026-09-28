import { raceAttempt } from '@sozai/async'
import { createGenerator } from '@sozai/flow'
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
  #currentResult?: NodeResult
  #activeGeneration = 0
  #activeContext?: ExecuteContext
  #handlers: Parameters<typeof createGenerator>[0]['handlers']
  #flow: ReturnType<typeof createGenerator>

  constructor(params: NodeExecutorParams) {
    this.#runner = params.runner
    this.#handlers = Object.fromEntries(
      [...this.#runner.kinds].map(([name, kind]) => [
        name,
        async ({
          state: flowState,
          params,
        }: {
          state: Record<string, unknown>
          params: { node: string }
        }) => {
          const node = required(
            Object.hasOwn(this.#runner.definition.nodes, params.node)
              ? this.#runner.definition.nodes[params.node]
              : undefined,
            ['frames', 0, 'node'],
          )

          if (
            this.#runner.event &&
            this.#runner.mode === 'resume' &&
            this.#runner.state.pending?.reason === 'suspend' &&
            !kind.resume
          ) {
            throw new FlowNodeFailure({ code: 'invalid_suspend' })
          }

          const generation = this.#activeGeneration

          const produced =
            this.#runner.event &&
            this.#runner.mode === 'resume' &&
            this.#runner.state.pending?.reason === 'suspend'
              ? await required(kind.resume, ['pending'])(
                  node,
                  required(this.#activeContext, ['frames', 0, 'node']),
                  this.#runner.event as ResumeEvent,
                )
              : await kind.execute(node, required(this.#activeContext, ['frames', 0, 'node']))

          if (generation === this.#activeGeneration) {
            this.#currentResult = produced
          }

          const nextID = produced && 'next' in produced ? produced.next : undefined

          const nextNode =
            nextID && Object.hasOwn(this.#runner.definition.nodes, nextID)
              ? this.#runner.definition.nodes[nextID]
              : undefined

          return nextNode
            ? {
                status: 'action' as const,
                state: flowState,
                action: { name: nextNode.kind, params: { node: nextID } },
              }
            : { status: 'state' as const, state: flowState }
        },
      ]),
    )

    this.#flow = createGenerator({
      handlers: this.#handlers,
      state: this.#runner.state as unknown as Record<string, unknown>,
      signal: this.#runner.signal,
    })
  }

  async runOne(params: RunOneParams): Promise<{ result: NodeResult; staged: Scope }> {
    const { nodeID, kind, attempt, invocationID, pending, deadline, timeoutMs } = params

    this.#activeGeneration++

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
      const execute = async (attemptSignal: AbortSignal) =>
        withActiveContext(nodeContext, async () => {
          this.#activeContext = {
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

          this.#currentResult = undefined

          const outcome = await this.#flow.next({
            action: { name: kind.kind, params: { node: nodeID } },
            state: this.#runner.state as unknown as Record<string, unknown>,
            signal: this.#runner.signal,
          })

          if (this.#runner.signal?.aborted) {
            throw this.#runner.signal.reason
          }

          const flowValue = outcome.value

          if (flowValue?.status === 'error') {
            this.#flow = createGenerator({
              handlers: this.#handlers,
              state: this.#runner.state as unknown as Record<string, unknown>,
              signal: this.#runner.signal,
            })

            const wrapped = flowValue.error

            throw wrapped instanceof Error &&
              wrapped.message === 'Handler execution failed' &&
              wrapped.cause !== undefined
              ? wrapped.cause
              : wrapped
          }

          if (flowValue?.status === 'aborted') {
            throw this.#runner.signal?.reason
          }

          const result = this.#currentResult as NodeResult | undefined

          if (!result) {
            throw new FlowNodeFailure({ code: 'invalid_value' })
          }

          return result
        })

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

      this.#flow = createGenerator({
        handlers: this.#handlers,
        state: this.#runner.state as unknown as Record<string, unknown>,
        signal: this.#runner.signal,
      })

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
