import { expect, test, vi } from 'vitest'

import type { FlowNode } from '../src/index.js'
import { createFlowGraph, defineNodeKind, readPath } from '../src/index.js'

const definition = (nodes: Record<string, FlowNode>, start = 'start') => ({
  id: 'regressions',
  name: 'Regressions',
  version: 1,
  start,
  nodes,
})
const observer = defineNodeKind<{ kind: 'observe'; next: string }>({
  kind: 'observe',
  schema: {
    type: 'object',
    required: ['kind', 'next'],
    additionalProperties: false,
    properties: { kind: { const: 'observe' }, next: { type: 'string' } },
  },
  targets: (node) => [{ path: ['next'], id: node.next }],
  execute: (_node, ctx) => {
    return { next: 'end', result: ctx.signal.aborted }
  },
})

test('a custom node after a handled timeout receives a live signal', async () => {
  vi.useFakeTimers()
  try {
    const graph = createFlowGraph({
      kinds: [observer],
      actions: { wait: async () => new Promise(() => {}) },
    })
    const pending = graph.run({
      definition: definition({
        start: {
          kind: 'action',
          name: 'wait',
          next: 'end',
          onError: 'custom',
          retry: { maxAttempts: 1, attemptTimeoutMs: 5 },
        },
        custom: { kind: 'observe', next: 'end' },
        end: { kind: 'end', output: { aborted: { ref: ['results', 'custom'] } } },
      }),
    })
    await vi.advanceTimersByTimeAsync(5)
    expect((await pending).output).toEqual({ aborted: false })
  } finally {
    vi.useRealTimers()
  }
})

test('run abort reaches a custom node after a successful action', async () => {
  const controller = new AbortController()
  let entered: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const graph = createFlowGraph({
    kinds: [
      {
        ...observer,
        execute: async (_node, ctx) => {
          entered?.()
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
          )
          return { next: 'end' }
        },
      },
    ],
    actions: { ok: async () => 1 },
  })
  const pending = graph.run({
    definition: definition({
      start: { kind: 'action', name: 'ok', next: 'custom' },
      custom: { kind: 'observe', next: 'end' },
      end: { kind: 'end' },
    }),
    signal: controller.signal,
  })
  await ready
  controller.abort('stop')
  expect((await pending).status).toBe('aborted')
})

test('checks cycles reachable only through a loop body edge', () => {
  const graph = createFlowGraph()
  const issues = graph.check(
    definition({
      start: {
        kind: 'loop',
        maxIterations: 2,
        while: { path: ['input'], is: { isNull: false } },
        body: 'a',
        exit: 'end',
      },
      a: { kind: 'set', assign: [{ path: ['state', 'x'], value: { value: 1 } }], next: 'b' },
      b: { kind: 'set', assign: [{ path: ['state', 'x'], value: { value: 2 } }], next: 'a' },
      end: { kind: 'end' },
    }),
  ).issues
  expect(issues.map((item) => item.code)).toContain('unbounded_cycle')
})

test('a ref assignment remains independent before and after a JSON round trip', async () => {
  const graph = createFlowGraph()
  const def = definition({
    start: {
      kind: 'set',
      assign: [
        { path: ['state', 'b'], value: { value: { x: 0 } } },
        { path: ['state', 'a'], value: { ref: ['state', 'b'] } },
        { path: ['state', 'b', 'x'], value: { value: 1 } },
      ],
      next: 'ask',
    },
    ask: { kind: 'input', next: 'end' },
    end: { kind: 'end', output: { a: { ref: ['state', 'a'] }, b: { ref: ['state', 'b'] } } },
  })
  const first = await graph.run({ definition: def })
  expect(first.runState.frames[0]?.state).toEqual({ a: { x: 0 }, b: { x: 1 } })
  const resumed = graph.resume({
    definition: def,
    runState: JSON.parse(JSON.stringify(first.runState)),
    event: { type: 'value', value: null },
  })
  for await (const _state of resumed) {
    /* drain */
  }
  expect(resumed.getState().output).toEqual({ a: { x: 0 }, b: { x: 1 } })
})

test('prototype names are not accepted as targets, actions or scope keys', async () => {
  const graph = createFlowGraph({ actions: { ok: async () => 1 } })
  expect(
    graph.check(
      definition({
        start: {
          kind: 'branch',
          cases: [{ when: { path: ['input'], is: { isNull: true } }, to: 'toString' }],
          default: 'end',
        },
        end: { kind: 'end' },
      }),
    ).issues,
  ).toContainEqual(
    expect.objectContaining({ code: 'unknown_target', path: ['nodes', 'start', 'cases', 0, 'to'] }),
  )
  const action = definition({
    start: { kind: 'action', name: 'toString', next: 'end' },
    end: { kind: 'end' },
  })
  expect(graph.check(action).issues.map((item) => item.code)).toContain('unknown_action')
  const unchecked = createFlowGraph()
  expect((await unchecked.run({ definition: action })).status).toBe('error')
  expect(
    readPath(['state', 'toString'], { input: null, state: {}, results: {}, loops: {} }),
  ).toBeNull()
})

test('recovery expires an in-flight attempt before replay', async () => {
  let clock = 1000
  const work = vi.fn(async () => 1)
  const graph = createFlowGraph({ now: () => clock, actions: { work } })
  const def = definition({
    start: {
      kind: 'action',
      name: 'work',
      retry: { maxAttempts: 2, totalTimeoutMs: 10 },
      next: 'end',
    },
    end: { kind: 'end' },
  })
  const run = graph.start({ definition: def })
  await run.next()
  const checkpoint = (await run.next()).value
  clock = 1010
  const recovered = graph.recover({ definition: def, runState: checkpoint })
  for await (const _state of recovered) {
    /* drain */
  }
  expect(recovered.getState().error?.reason).toBe('total_timeout')
  expect(work).not.toHaveBeenCalled()
})

test('schema errors identify the invalid filter operator', () => {
  const issues = createFlowGraph().check(
    definition({
      start: {
        kind: 'branch',
        cases: [{ when: { path: ['input'], is: { equals: 1 } }, to: 'end' }],
        default: 'end',
      },
      end: { kind: 'end' },
    }),
  ).issues
  expect(issues).toContainEqual(
    expect.objectContaining({
      code: 'schema',
      path: ['nodes', 'start', 'cases', 0, 'when', 'is', 'equals'],
      hint: expect.stringContaining('equalTo'),
    }),
  )
  expect(issues.some((item) => item.code === 'schema' && item.path.length === 0)).toBe(false)
  expect(issues.filter((item) => item.code === 'schema')).toHaveLength(1)
})

test('an empty nodes map gets a field-level schema issue', () => {
  const issues = createFlowGraph().check(definition({})).issues
  expect(issues).toContainEqual(expect.objectContaining({ code: 'schema', path: ['nodes'] }))
})

const reservedDefinitions: Array<Record<string, FlowNode>> = [
  { start: { kind: 'goto', flow: 'other' } },
  { start: { kind: 'call', flow: 'other', next: 'end' }, end: { kind: 'end' } },
  {
    start: {
      kind: 'loop',
      maxIterations: 2,
      while: { path: ['input'], is: { isNull: false } },
      body: { flow: 'other' },
      exit: 'end',
    },
    end: { kind: 'end' },
  },
]
test.each(reservedDefinitions)(
  'reserved nodes receive only an unsupported issue at their node path',
  (nodes) => {
    const issues = createFlowGraph().check(definition(nodes)).issues
    expect(issues).toEqual([
      expect.objectContaining({ code: 'unsupported', path: ['nodes', 'start'] }),
    ])
  },
)

test('an array item declared in resultSchema can be referenced', () => {
  const graph = createFlowGraph({
    kinds: [
      defineNodeKind<{ kind: 'produce'; next: string }>({
        kind: 'produce',
        schema: {
          type: 'object',
          required: ['kind', 'next'],
          properties: { kind: { const: 'produce' }, next: { type: 'string' } },
        },
        targets: (node) => [{ path: ['next'], id: node.next }],
        resultSchema: () => ({
          type: 'object',
          properties: {
            rows: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' } },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        }),
        execute: (node) => ({ next: node.next, result: { rows: [{ name: 'ok' }] } }),
      }),
    ],
  })
  const issues = graph.check(
    definition({
      start: { kind: 'produce', next: 'end' },
      end: { kind: 'end', output: { name: { ref: ['results', 'start', 'rows', '0', 'name'] } } },
    }),
  ).issues
  expect(issues.map((item) => item.code)).not.toContain('invalid_result_path')
})

test('a node named assign still checks a filter path as a read', () => {
  const issues = createFlowGraph().check(
    definition(
      {
        assign: {
          kind: 'branch',
          cases: [{ when: { path: ['wrong'], is: { isNull: true } }, to: 'end' }],
          default: 'end',
        },
        end: { kind: 'end' },
      },
      'assign',
    ),
  ).issues
  expect(issues).toContainEqual(
    expect.objectContaining({ code: 'invalid_path', message: 'Invalid scope path.' }),
  )
})

test('a non-Error thrown by a kind reaches retryable and describeError', async () => {
  let count = 0
  const graph = createFlowGraph({
    kinds: [
      defineNodeKind<{ kind: 'throwing'; next: string }>({
        kind: 'throwing',
        schema: {
          type: 'object',
          required: ['kind', 'next'],
          properties: { kind: { const: 'throwing' }, next: { type: 'string' } },
        },
        targets: (node) => [{ path: ['next'], id: node.next }],
        retries: true,
        retryable: (error) => error === 'retry me',
        describeError: (error) => ({
          type: error === 'retry me' ? 'OriginalValue' : 'WrappedValue',
        }),
        execute: (node) => {
          if (count++ === 0) throw 'retry me'
          return { next: node.next }
        },
      }),
    ],
  })
  const result = await graph.run({
    definition: definition({
      start: { kind: 'throwing', retry: { maxAttempts: 2 }, next: 'end' },
      end: { kind: 'end' },
    }),
  })
  expect(result.status).toBe('ended')
  expect(count).toBe(2)
})

test('an undefined action result fails with invalid_value', async () => {
  const graph = createFlowGraph({ actions: { empty: async () => undefined as never } })
  const result = await graph.run({
    definition: definition({
      start: { kind: 'action', name: 'empty', next: 'end' },
      end: { kind: 'end' },
    }),
  })
  expect(result.error?.code).toBe('invalid_value')
})

test('node:enter fires for a non-retrying node', async () => {
  const graph = createFlowGraph()
  const run = graph.start({ definition: definition({ start: { kind: 'end' } }) })
  const nodes: Array<string> = []
  run.events.on('node:enter', ({ node }) => {
    nodes.push(node)
  })
  for await (const _state of run) {
    /* drain */
  }
  expect(nodes).toEqual(['start'])
})

test('run preserves an empty outcome', async () => {
  const graph = createFlowGraph({
    kinds: [
      defineNodeKind<{ kind: 'finish'; next: string }>({
        kind: 'finish',
        schema: {
          type: 'object',
          required: ['kind', 'next'],
          properties: { kind: { const: 'finish' }, next: { type: 'string' } },
        },
        targets: (node) => [{ path: ['next'], id: node.next }],
        execute: () => ({ end: { outcome: '' } }),
      }),
    ],
  })
  const result = await graph.run({
    definition: definition({ start: { kind: 'finish', next: 'end' }, end: { kind: 'end' } }),
  })
  expect(result).toHaveProperty('outcome', '')
})

test('a custom kind field named path is not checked as a scope path', () => {
  const fetcher = defineNodeKind<{ kind: 'fetch'; path: Array<string>; next: string }>({
    kind: 'fetch',
    schema: {
      type: 'object',
      required: ['kind', 'path', 'next'],
      additionalProperties: false,
      properties: {
        kind: { const: 'fetch' },
        path: { type: 'array', items: { type: 'string' } },
        next: { type: 'string' },
      },
    },
    targets: (node) => [{ path: ['next'], id: node.next }],
    execute: (node) => {
      return { next: node.next }
    },
  })
  const graph = createFlowGraph({ kinds: [fetcher] })
  const result = graph.check(
    definition({
      start: { kind: 'fetch', path: ['api', 'users'], next: 'check' },
      check: {
        kind: 'branch',
        cases: [{ when: { path: ['nowhere', 'x'], is: { isNull: true } }, to: 'end' }],
        default: 'end',
      },
      end: { kind: 'end' },
    }),
  )
  expect(result.issues.map((issue) => [issue.code, issue.path])).toEqual([
    ['invalid_path', ['nodes', 'check', 'cases', 0, 'when', 'path']],
  ])
})
