import { TimeoutInterruption } from '@sozai/async'
import type { JSONValue } from '@sozai/json'
import type { Schema } from '@sozai/schema'

import { FlowRetryableError } from './errors.js'
import type { Filter } from './filter.js'
import { builtinSchemas } from './schemas.js'
import { toTimestamp } from './time.js'
import type { Action, NodeKind, RegisteredNodeKind } from './types.js'
import type { Path, Value } from './value.js'
import { writeState } from './value.js'

type BranchNode = { kind: 'branch'; cases: Array<{ when: Filter; to: string }>; default: string }

type SetNode = { kind: 'set'; assign: Array<{ path: Path; value: Value }>; next: string }

type LoopNode = {
  kind: 'loop'
  while: Filter
  maxIterations: number
  body: string
  exit: string
  onExhausted?: string
}

type ActionNode = {
  kind: 'action'
  name: string
  args?: Record<string, Value>
  next: string
  onError?: string
}

type InputNode = {
  kind: 'input'
  prompt?: Value
  schema?: Schema
  next: string
  timeout?: { afterMs: number; to: string }
}

type EndNode = { kind: 'end'; outcome?: string; output?: Record<string, Value> }

/** Safe error code for a node failure. */
export type FlowNodeFailureParams = { code: string }

const target = (path: string, id: string) => ({ path: [path], id })

/** Create the built-in node kinds for one graph runtime. */
export function builtinKinds(
  actions?: Record<string, Action>,
  now: () => number = Date.now,
): Array<RegisteredNodeKind> {
  const branch: NodeKind<BranchNode> = {
    kind: 'branch',
    schema: builtinSchemas.branch,
    targets: (node) => [
      ...node.cases.map((branch, index) => ({ path: ['cases', index, 'to'], id: branch.to })),
      target('default', node.default),
    ],
    execute: (node, ctx) => {
      const index = node.cases.findIndex((branch) => ctx.evaluate(branch.when))

      ctx.span.setAttribute('flow.branch.case', index < 0 ? 'default' : index)

      return { next: index < 0 ? node.default : (node.cases[index]?.to ?? node.default) }
    },
  }

  const set: NodeKind<SetNode> = {
    kind: 'set',
    schema: builtinSchemas.set,
    targets: (node) => [target('next', node.next)],
    execute: (node, ctx) => {
      for (const entry of node.assign) {
        writeState(
          ctx.scope.state as Record<string, JSONValue>,
          entry.path,
          ctx.resolve(entry.value),
        )
      }

      return { next: node.next }
    },
  }

  const loop: NodeKind<LoopNode> = {
    kind: 'loop',
    schema: builtinSchemas.loop,
    targets: (node) => [
      target('body', node.body),
      target('exit', node.exit),
      ...(node.onExhausted ? [target('onExhausted', node.onExhausted)] : []),
    ],
    execute: (node, ctx) => {
      const loops = ctx.scope.loops as Record<string, number>

      if (!ctx.evaluate(node.while)) {
        delete loops[ctx.nodeID]

        return { next: node.exit }
      }

      const count = Object.hasOwn(loops, ctx.nodeID) ? (loops[ctx.nodeID] as number) : 0

      if (count >= node.maxIterations) {
        delete loops[ctx.nodeID]

        if (!node.onExhausted) {
          throw new FlowNodeFailure({ code: 'loop_exhausted' })
        }

        return { next: node.onExhausted }
      }

      loops[ctx.nodeID] = count + 1

      ctx.span.setAttribute('flow.loop.iteration', count + 1)

      return { next: node.body }
    },
  }

  const action: NodeKind<ActionNode> = {
    kind: 'action',
    schema: builtinSchemas.action,
    retries: true,
    targets: (node) => [
      target('next', node.next),
      ...(node.onError ? [target('onError', node.onError)] : []),
    ],
    retryable: (error) => {
      return error instanceof FlowRetryableError
        ? error.afterMs === undefined
          ? true
          : { afterMs: error.afterMs }
        : error instanceof TimeoutInterruption && error.cause === 'attempt'
    },
    execute: async (node, ctx) => {
      ctx.span.setAttribute('flow.action.name', node.name)

      const args = Object.fromEntries(
        Object.entries(node.args ?? {}).map(([key, value]) => [key, ctx.resolve(value as Value)]),
      )

      const actionHandler =
        actions && Object.hasOwn(actions, node.name) ? actions[node.name] : undefined

      if (!actionHandler) {
        throw new FlowNodeFailure({ code: 'unknown_action' })
      }

      const result = await actionHandler({
        args,
        signal: ctx.signal,
        runID: ctx.runID,
        nodeID: ctx.nodeID,
        invocationID: ctx.invocationID,
        attempt: ctx.attempt,
      })

      return { next: node.next, result }
    },
  }

  const input: NodeKind<InputNode> = {
    kind: 'input',
    schema: builtinSchemas.input,
    targets: (node) => [
      target('next', node.next),
      ...(node.timeout ? [target('timeout', node.timeout.to)] : []),
    ],
    execute: (node, ctx) => {
      return {
        suspend: {
          ...(node.prompt ? { prompt: ctx.resolve(node.prompt) } : {}),
          ...(node.schema ? { schema: node.schema } : {}),
          ...(node.timeout ? { deadline: toTimestamp(now() + node.timeout.afterMs) } : {}),
        },
      }
    },
    resume: (node, _ctx, event) => {
      if (event.type === 'timeout') {
        if (!node.timeout) {
          throw new FlowNodeFailure({ code: 'invalid_suspend' })
        }

        return { next: node.timeout.to }
      }

      return { next: node.next, result: event.value }
    },
  }

  const end: NodeKind<EndNode> = {
    kind: 'end',
    schema: builtinSchemas.end,
    targets: () => [],
    execute: (node, ctx) => {
      return {
        end: {
          ...(node.outcome ? { outcome: node.outcome } : {}),
          ...(node.output
            ? {
                output: Object.fromEntries(
                  Object.entries(node.output).map(([key, value]) => [
                    key,
                    ctx.resolve(value as Value),
                  ]),
                ),
              }
            : {}),
        },
      }
    },
  }

  return [branch, set, loop, action, input, end] as Array<RegisteredNodeKind>
}

/** Internal failure carrying a safe node error code. */
export class FlowNodeFailure extends Error {
  #code: string

  constructor(params: FlowNodeFailureParams) {
    super(params.code)

    this.name = 'FlowNodeFailure'
    this.#code = params.code
  }

  get code(): string {
    return this.#code
  }
}
