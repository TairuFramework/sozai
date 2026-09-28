import { getSozaiLogger } from '@sozai/log'
import { expect, test, vi } from 'vitest'

import type { NodeKind } from '../src/index.js'
import { createFlowGraph, defineNodeKind } from '../src/index.js'

test('loop limit resets its counter before ending with an error', async () => {
  const definition = {
    id: 'loop',
    name: 'Loop',
    version: 1,
    start: 'seed',
    nodes: {
      seed: {
        kind: 'set',
        assign: [{ path: ['state', 'count'], value: { value: 0 } }],
        next: 'loop',
      },
      loop: {
        kind: 'loop',
        maxIterations: 3,
        while: { path: ['state', 'count'], is: { lessThan: 2 } },
        body: 'body',
        exit: 'end',
      },
      body: { kind: 'action', name: 'increment', next: 'loop' },
      end: { kind: 'end' },
    },
  }
  let count = 0
  const graph = createFlowGraph({ actions: { increment: async () => ++count } })
  const result = await graph.run({ definition })
  // The action writes results only; the state used by the filter stays at zero,
  // so the third loop entry reaches the declared iteration limit.
  expect(result.status).toBe('error')
  expect(result.error?.code).toBe('loop_exhausted')
  expect(result.runState.frames[0]?.loops.loop).toBeUndefined()
  expect(result.runState.steps).toBe(8)
  expect(result.runState.frames[0]?.invocation).toBe(8)
})

test('loop resets its counter on a false filter and re-entry gets a new invocation', async () => {
  const invocations: Array<string> = []
  let count = 0
  const graph = createFlowGraph({
    actions: {
      tick: async ({ invocationID }) => {
        invocations.push(invocationID)
        return ++count
      },
    },
  })
  const definition = {
    id: 'exit',
    name: 'Exit',
    version: 1,
    start: 'seed',
    nodes: {
      seed: {
        kind: 'set',
        assign: [{ path: ['state', 'count'], value: { value: 0 } }],
        next: 'loop',
      },
      loop: {
        kind: 'loop',
        maxIterations: 3,
        while: { path: ['state', 'count'], is: { lessThan: 2 } },
        body: 'tick',
        exit: 'end',
      },
      tick: { kind: 'action', name: 'tick', next: 'assign' },
      assign: {
        kind: 'set',
        assign: [{ path: ['state', 'count'], value: { ref: ['results', 'tick'] } }],
        next: 'loop',
      },
      end: { kind: 'end' },
    },
  }
  const result = await graph.run({ definition })
  expect(result.status).toBe('ended')
  expect(result.runState.frames[0]?.loops).toEqual({})
  expect(invocations).toHaveLength(2)
  expect(invocations[0]).not.toBe(invocations[1])
})

test('onError receives a safe error result and discards staged data', async () => {
  const kind = defineNodeKind({
    kind: 'staged',
    schema: {
      type: 'object',
      required: ['kind', 'next', 'onError'],
      properties: {
        kind: { const: 'staged' },
        next: { type: 'string' },
        onError: { type: 'string' },
      },
      additionalProperties: false,
    },
    targets: () => [
      { path: ['next'], id: 'done' },
      { path: ['onError'], id: 'handled' },
    ],
    execute: (_node, ctx) => {
      ctx.setResult({ secret: 'must-discard' })
      throw new Error('backend secret')
    },
  })
  const definition = {
    id: 'fail',
    name: 'Failure',
    version: 1,
    start: 'start',
    nodes: {
      start: { kind: 'staged', next: 'done', onError: 'handled' },
      done: { kind: 'end' },
      handled: {
        kind: 'end',
        output: {
          errorType: { ref: ['results', 'start', 'error', 'type'] },
          secret: { ref: ['results', 'start', 'secret'] },
        },
      },
    },
  }
  const graph = createFlowGraph({ kinds: [kind] })
  const result = await graph.run({ definition })
  expect(result.status).toBe('ended')
  expect(result.output).toEqual({ errorType: 'Error', secret: null })
  expect(JSON.stringify(result.runState)).not.toContain('backend secret')
})

test('invalid extension transition fails with invalid_target', async () => {
  const kind = defineNodeKind({
    kind: 'bad',
    schema: {
      type: 'object',
      required: ['kind'],
      properties: { kind: { const: 'bad' } },
      additionalProperties: false,
    },
    targets: () => [{ path: ['next'], id: 'end' }],
    execute: () => ({ next: 'ghost' }),
  })
  const result = await createFlowGraph({ kinds: [kind] }).run({
    definition: {
      id: 'bad',
      name: 'Bad',
      version: 1,
      start: 'bad',
      nodes: { bad: { kind: 'bad' }, end: { kind: 'end' } },
    },
  })
  expect(result.status).toBe('error')
  expect(result.error?.code).toBe('invalid_target')
})

test('non-JSON extension result fails with invalid_value', async () => {
  const kind: NodeKind = {
    kind: 'bad',
    schema: {
      type: 'object',
      required: ['kind'],
      properties: { kind: { const: 'bad' } },
      additionalProperties: false,
    },
    targets: () => [{ path: ['next'], id: 'end' }],
    execute: () => ({ next: 'end', result: Number.NaN }),
  }
  const result = await createFlowGraph({ kinds: [kind] }).run({
    definition: {
      id: 'bad',
      name: 'Bad',
      version: 1,
      start: 'bad',
      nodes: { bad: { kind: 'bad' }, end: { kind: 'end' } },
    },
  })
  expect(result.error?.code).toBe('invalid_value')
})

test('maxSteps stops a bounded graph before the next entry', async () => {
  const definition = {
    id: 'limit',
    name: 'Limit',
    version: 1,
    start: 'start',
    nodes: {
      start: { kind: 'set', assign: [{ path: ['state', 'x'], value: { value: 1 } }], next: 'end' },
      end: { kind: 'end' },
    },
  }
  const result = await createFlowGraph({ maxSteps: 1 }).run({ definition })
  expect(result.error?.code).toBe('max_steps')
  expect(result.runState.steps).toBe(1)
})

test('an aborted action closes the run without applying a late result', async () => {
  const controller = new AbortController()
  const graph = createFlowGraph({ actions: { wait: async () => new Promise<number>(() => {}) } })
  const definition = {
    id: 'abort',
    name: 'Abort',
    version: 1,
    start: 'a',
    nodes: { a: { kind: 'action', name: 'wait', next: 'end' }, end: { kind: 'end' } },
  }
  const pending = graph.run({ definition, signal: controller.signal })
  await Promise.resolve()
  controller.abort()
  const result = await pending
  expect(result.status).toBe('aborted')
  expect(result.runState.frames[0]?.results).toEqual({})
})

test('unconfigured logging reports run errors even with an injected logger', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const graph = createFlowGraph({
      logger: getSozaiLogger('custom'),
      actions: {
        fail: async () => {
          throw new Error('private text')
        },
      },
    })
    const result = await graph.run({
      definition: {
        id: 'logging',
        name: 'Logging',
        version: 1,
        start: 'a',
        nodes: { a: { kind: 'action', name: 'fail', next: 'end' }, end: { kind: 'end' } },
      },
    })
    expect(result.status).toBe('error')
    expect(spy).toHaveBeenCalledOnce()
    expect(JSON.stringify(spy.mock.calls)).not.toContain('private text')
  } finally {
    spy.mockRestore()
  }
})
