import { raceAttempt } from '@sozai/async'
import type { JSONValue } from '@sozai/json'
import { setSpanOnContext, withActiveContext } from '@sozai/otel'

import { FlowNodeFailure } from './errors.js'
import { evaluateFilter } from './filter.js'
import { defaultMaxDepth, top, topIndex } from './frames.js'
import type { InternalNodeResult } from './reference-kinds.js'
import type { PreparedFlow } from './resolver.js'
import type { FlowRunner } from './run.js'
import { clone, defaultMeta, required, requireJSON, tracer } from './run-utils.js'
import { isCanonicalTimestamp } from './time.js'
import type { ExecuteContext, NodeKind, ResumeEvent, RunState } from './types.js'
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

/** Node result, staged scope and, for a push or replace, the prepared flow snapshot. */
export type RunOneResult = { result: InternalNodeResult; staged: Scope; prepared?: PreparedFlow }

/** Built-in kinds allowed to push a frame; custom kinds cannot register these names. */
const pushingKinds = new Set(['call', 'loop'])

/** Built-in kinds allowed to replace the top frame; custom kinds cannot register these names. */
const replacingKinds = new Set(['goto'])

type NodeExecutorParams = { runner: FlowRunner }

export class NodeExecutor {
  #runner: FlowRunner

  constructor(params: NodeExecutorParams) {
    this.#runner = params.runner
  }

  async runOne(params: RunOneParams): Promise<RunOneResult> {
    const { nodeID, kind, attempt, invocationID, pending, deadline, timeoutMs } = params

    const frame = top(this.#runner.state)

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
          'flow.id': frame.flow.id,
          'flow.depth': topIndex(this.#runner.state),
          'flow.node.id': nodeID,
          'flow.node.kind': kind.kind,
          'flow.attempt': attempt,
        },
      },
      this.#runner.segmentContext,
    )

    const nodeContext = setSpanOnContext(this.#runner.segmentContext, nodeSpan)
    let thrown: unknown
    let prepared: PreparedFlow | undefined

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
            Object.hasOwn(this.#runner.activeDefinition.nodes, nodeID)
              ? this.#runner.activeDefinition.nodes[nodeID]
              : undefined,
            ['frames', topIndex(this.#runner.state), 'node'],
          )

          const resumeEvent =
            this.#runner.mode === 'resume' && this.#runner.state.pending?.reason === 'suspend'
              ? (this.#runner.event as ResumeEvent | undefined)
              : undefined

          if (resumeEvent && !kind.resume) {
            throw new FlowNodeFailure({ code: 'invalid_suspend' })
          }

          // Built-in kinds may return internal stack transitions.
          const result = (
            resumeEvent
              ? await required(kind.resume, ['pending'])(node, context, resumeEvent)
              : await kind.execute(node, context)
          ) as InternalNodeResult

          if (result && 'push' in result && pushingKinds.has(kind.kind)) {
            requireJSON(result)

            const maxDepth = this.#runner.options.maxDepth ?? defaultMaxDepth

            if (this.#runner.state.frames.length + 1 > maxDepth) {
              throw new FlowNodeFailure({ code: 'max_depth' })
            }

            prepared = await this.#runner.references.prepare(result.push.ref, result.push.input, {
              signal: this.#runner.signal,
            })
          } else if (result && 'replace' in result && replacingKinds.has(kind.kind)) {
            requireJSON(result)

            // Replacing keeps the stack depth, so no depth check applies.
            prepared = await this.#runner.references.prepare(
              result.replace.ref,
              result.replace.input,
              { signal: this.#runner.signal },
            )
          }

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

      if ('push' in result || 'replace' in result) {
        // Only the gated built-in kinds prepare a snapshot; any other stack transition is invalid.
        if (!prepared) {
          throw new FlowNodeFailure({ code: 'invalid_value' })
        }
      } else if ('suspend' in result) {
        if (
          !kind.resume ||
          (result.suspend.deadline && !isCanonicalTimestamp(result.suspend.deadline))
        ) {
          throw new FlowNodeFailure({ code: 'invalid_suspend' })
        }

        if (result.suspend.schema) {
          try {
            this.#runner.validatorFor(result.suspend.schema)
          } catch {
            // biome-ignore lint/style/useErrorCause: schema compile errors may carry private data
            throw new FlowNodeFailure({ code: 'invalid_suspend' })
          }
        }
      } else if ('next' in result) {
        if (
          !kind
            .targets(
              required(this.#runner.activeDefinition.nodes[nodeID], [
                'frames',
                topIndex(this.#runner.state),
                'node',
              ]),
            )
            .some((edge) => edge.id === result.next)
        ) {
          throw new FlowNodeFailure({ code: 'invalid_target' })
        }

        nodeSpan.setAttribute('flow.next', result.next)

        if ('result' in result) {
          requireJSON(result.result)

          staged.results[nodeID] = result.result as JSONValue
        }
      } else if (!('end' in result) || !kind.terminal) {
        throw new FlowNodeFailure({ code: 'invalid_value' })
      }

      requireJSON(staged)

      return { result, staged, ...(prepared ? { prepared } : {}) }
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
