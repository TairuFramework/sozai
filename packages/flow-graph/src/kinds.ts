import { TimeoutInterruption } from '@sozai/async'
import type { JSONValue } from '@sozai/json'
import type { Schema } from '@sozai/schema'

import { FlowRetryableError } from './errors.js'
import type { Filter } from './filter.js'
import { builtinSchemas } from './schemas.js'
import { toTimestamp } from './time.js'
import type { Action, NodeKind } from './types.js'
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
const target = (path: string, id: string) => ({ path: [path], id })
export function builtinKinds(
  actions?: Record<string, Action>,
  now: () => number = Date.now,
): Array<NodeKind<never>> {
  const branch: NodeKind<BranchNode> = {
    kind: 'branch',
    schema: builtinSchemas.branch,
    targets: (n) => [
      ...n.cases.map((c, i) => ({ path: ['cases', i, 'to'], id: c.to })),
      target('default', n.default),
    ],
    execute: (n, ctx) => {
      const index = n.cases.findIndex((c) => ctx.evaluate(c.when))
      ctx.span.setAttribute('flow.branch.case', index < 0 ? 'default' : index)
      return { next: index < 0 ? n.default : (n.cases[index]?.to ?? n.default) }
    },
  }
  const set: NodeKind<SetNode> = {
    kind: 'set',
    schema: builtinSchemas.set,
    targets: (n) => [target('next', n.next)],
    execute: (n, ctx) => {
      for (const entry of n.assign)
        writeState(
          ctx.scope.state as Record<string, JSONValue>,
          entry.path,
          ctx.resolve(entry.value),
        )
      return { next: n.next }
    },
  }
  const loop: NodeKind<LoopNode> = {
    kind: 'loop',
    schema: builtinSchemas.loop,
    targets: (n) => [
      target('body', n.body),
      target('exit', n.exit),
      ...(n.onExhausted ? [target('onExhausted', n.onExhausted)] : []),
    ],
    execute: (n, ctx) => {
      const loops = ctx.scope.loops as Record<string, number>
      if (!ctx.evaluate(n.while)) {
        delete loops[ctx.nodeID]
        return { next: n.exit }
      }
      const count = loops[ctx.nodeID] ?? 0
      if (count >= n.maxIterations) {
        delete loops[ctx.nodeID]
        if (!n.onExhausted) throw new FlowNodeFailure({ code: 'loop_exhausted' })
        return { next: n.onExhausted }
      }
      loops[ctx.nodeID] = count + 1
      ctx.span.setAttribute('flow.loop.iteration', count + 1)
      return { next: n.body }
    },
  }
  const action: NodeKind<ActionNode> = {
    kind: 'action',
    schema: builtinSchemas.action,
    retries: true,
    targets: (n) => [target('next', n.next), ...(n.onError ? [target('onError', n.onError)] : [])],
    retryable: (error) =>
      error instanceof FlowRetryableError
        ? error.afterMs === undefined
          ? true
          : { afterMs: error.afterMs }
        : error instanceof TimeoutInterruption && error.cause === 'attempt',
    execute: async (n, ctx) => {
      ctx.span.setAttribute('flow.action.name', n.name)
      const args = Object.fromEntries(
        Object.entries(n.args ?? {}).map(([key, value]) => [key, ctx.resolve(value as Value)]),
      )
      const fn = actions?.[n.name]
      if (!fn) throw new FlowNodeFailure({ code: 'unknown_action' })
      const result = await fn({
        args,
        signal: ctx.signal,
        runID: ctx.runID,
        nodeID: ctx.nodeID,
        invocationID: ctx.invocationID,
        attempt: ctx.attempt,
      })
      return { next: n.next, result }
    },
  }
  const input: NodeKind<InputNode> = {
    kind: 'input',
    schema: builtinSchemas.input,
    targets: (n) => [
      target('next', n.next),
      ...(n.timeout ? [target('timeout', n.timeout.to)] : []),
    ],
    execute: (n, ctx) => ({
      suspend: {
        ...(n.prompt ? { prompt: ctx.resolve(n.prompt) } : {}),
        ...(n.schema ? { schema: n.schema } : {}),
        ...(n.timeout ? { deadline: toTimestamp(now() + n.timeout.afterMs) } : {}),
      },
    }),
    resume: (n, _ctx, event) => {
      if (event.type === 'timeout') {
        if (!n.timeout) throw new FlowNodeFailure({ code: 'invalid_suspend' })
        return { next: n.timeout.to }
      }
      return { next: n.next, result: event.value }
    },
  }
  const end: NodeKind<EndNode> = {
    kind: 'end',
    schema: builtinSchemas.end,
    targets: () => [],
    execute: (n, ctx) => ({
      end: {
        ...(n.outcome ? { outcome: n.outcome } : {}),
        ...(n.output
          ? {
              output: Object.fromEntries(
                Object.entries(n.output).map(([key, value]) => [key, ctx.resolve(value as Value)]),
              ),
            }
          : {}),
      },
    }),
  }
  return [branch, set, loop, action, input, end] as Array<NodeKind<never>>
}

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

export type FlowNodeFailureParams = { code: string }
