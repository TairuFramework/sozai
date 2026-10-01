import { TimeoutInterruption } from '@sozai/async'
import type { JSONValue } from '@sozai/json'
import type { Schema } from '@sozai/schema'

import { FlowNodeFailure, FlowRetryableError } from './errors.js'
import type { Filter } from './filter.js'
import type { FlowReference, ReferenceService } from './reference-kinds.js'
import {
  internalResult,
  referenceKinds,
  referenceResultSchema,
  referenceTarget,
  resolveReferenceInput,
} from './reference-kinds.js'
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
  body: string | FlowReference
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
  decline?: { to: string }
  timeout?: { afterMs: number; to: string }
}

type EndNode = {
  kind: 'end'
  outcome?: string | Extract<Value, { ref: Path }>
  output?: Record<string, Value>
}

/** Actions, clock and reference service used by the built-in node kinds. */
export type BuiltinKindsParams = {
  actions?: Record<string, Action>
  now: () => number
  references: ReferenceService
}

const target = (path: string, id: string) => ({ path: [path], id })

/** Create the built-in node kinds for one graph runtime. */
export function builtinKinds(params: BuiltinKindsParams): Array<RegisteredNodeKind> {
  const { actions, now, references } = params

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
      // A flow body runs in a pushed frame, so it has no local body edge.
      ...(typeof node.body === 'string' ? [target('body', node.body)] : []),
      target('exit', node.exit),
      ...(node.onExhausted ? [target('onExhausted', node.onExhausted)] : []),
    ],
    resultSchema: (node) => (typeof node.body === 'object' ? referenceResultSchema : {}),
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

      if (typeof node.body !== 'string') {
        // The runner resolves, snapshots and validates the body flow before pushing it; the
        // pop returns to this loop with the body result in `results.<loop>`.
        return internalResult({
          push: {
            ref: referenceTarget(node.body),
            input: resolveReferenceInput(node.body, ctx),
            continuation: { kind: 'loopBody', callerNode: ctx.nodeID, returnTo: ctx.nodeID },
          },
        })
      }

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
      ...(node.decline ? [target('decline', node.decline.to)] : []),
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

      if (event.type === 'decline') {
        if (!node.decline) {
          throw new FlowNodeFailure({ code: 'invalid_suspend' })
        }

        return { next: node.decline.to, result: { declined: event.reason ?? 'decline' } }
      }

      return { next: node.next, result: event.value }
    },
  }

  const end: NodeKind<EndNode> = {
    kind: 'end',
    terminal: true,
    schema: builtinSchemas.end,
    targets: () => [],
    execute: (node, ctx) => {
      const outcome = typeof node.outcome === 'object' ? ctx.resolve(node.outcome) : node.outcome

      if (outcome !== undefined && typeof outcome !== 'string') {
        const actualType =
          outcome === null ? 'null' : Array.isArray(outcome) ? 'array' : typeof outcome
        const error = new FlowNodeFailure({ code: 'invalid_value' })

        error.message = `End outcome must resolve to a string; received ${actualType}.`

        throw error
      }

      return {
        end: {
          ...(outcome !== undefined ? { outcome } : {}),
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

  return [
    branch,
    set,
    loop,
    action,
    input,
    end,
    ...referenceKinds({ references }),
  ] as Array<RegisteredNodeKind>
}
