import { expect, test } from 'vitest'

import type { FlowGraph, FlowIssue, FlowNode } from '../src/index.js'
import { createFlowGraph, defineNodeKind } from '../src/index.js'

const graph = createFlowGraph({ actions: { ok: async () => 1 } })

const definition = (nodes: Record<string, FlowNode>, start = 'start') => ({
  id: 'rules',
  name: 'Rules',
  version: 1,
  start,
  nodes,
})

const end = { kind: 'end' }

const resultGraph = createFlowGraph({
  kinds: [
    defineNodeKind({
      kind: 'producer',
      schema: {
        type: 'object',
        required: ['kind', 'next'],
        properties: { kind: { const: 'producer' }, next: { type: 'string' } },
        additionalProperties: false,
      },
      targets: (node: { kind: 'producer'; next: string }) => [{ path: ['next'], id: node.next }],
      resultSchema: () => ({ type: 'object', properties: { answer: { type: 'string' } } }),
      execute: (node) => ({ next: node.next, result: { answer: 'yes' } }),
    }),
  ],
})

type RuleFixture = {
  code: string
  path: Array<string | number>
  definition: unknown
  graph?: FlowGraph
}

const fixtures: Array<RuleFixture> = [
  { code: 'schema', path: [], definition: { ...definition({ start: end }), version: Number.NaN } },
  {
    code: 'unknown_kind',
    path: ['nodes', 'start', 'kind'],
    definition: definition({ start: { kind: 'alien' } }),
  },
  {
    code: 'unknown_target',
    path: ['nodes', 'start', 'next'],
    definition: definition({ start: { kind: 'action', name: 'ok', next: 'missing' } }),
  },
  {
    code: 'invalid_path',
    path: ['nodes', 'start', 'assign', 0, 'path'],
    definition: definition({
      start: {
        kind: 'set',
        assign: [{ path: ['state', '__proto__'], value: { value: 1 } }],
        next: 'end',
      },
      end,
    }),
  },
  {
    code: 'invalid_error_path',
    path: ['nodes', 'end', 'output', 'bad', 'ref'],
    definition: definition({
      start: { kind: 'action', name: 'ok', next: 'end', onError: 'end' },
      end: { kind: 'end', output: { bad: { ref: ['results', 'start', 'error', 'message'] } } },
    }),
  },
  {
    code: 'invalid_result_path',
    path: ['nodes', 'end', 'output', 'bad', 'ref'],
    graph: resultGraph,
    definition: definition({
      start: { kind: 'producer', next: 'end' },
      end: { kind: 'end', output: { bad: { ref: ['results', 'start', 'missing'] } } },
    }),
  },
  {
    code: 'result_maybe_missing',
    path: ['nodes', 'end', 'output', 'value', 'ref'],
    definition: definition({
      start: {
        kind: 'branch',
        cases: [{ when: { path: ['input'], is: { isNull: true } }, to: 'work' }],
        default: 'end',
      },
      work: { kind: 'action', name: 'ok', next: 'end' },
      end: { kind: 'end', output: { value: { ref: ['results', 'work'] } } },
    }),
  },
  {
    code: 'unreachable',
    path: ['nodes', 'dead'],
    definition: definition({ start: end, dead: end }),
  },
  {
    code: 'no_end',
    path: ['nodes', 'start'],
    definition: definition({
      start: {
        kind: 'set',
        assign: [{ path: ['state', 'x'], value: { value: 1 } }],
        next: 'start',
      },
    }),
  },
  {
    code: 'unbounded_cycle',
    path: ['nodes'],
    definition: definition({
      start: {
        kind: 'loop',
        maxIterations: 2,
        while: { path: ['input'], is: { isNull: false } },
        body: 'end',
        exit: 'start',
      },
      end,
    }),
  },
  {
    code: 'unknown_action',
    path: ['nodes', 'start', 'name'],
    definition: definition({ start: { kind: 'action', name: 'missing', next: 'end' }, end }),
  },
  {
    code: 'invalid_retry',
    path: ['nodes', 'start', 'retry'],
    definition: definition({
      start: { kind: 'action', name: 'ok', next: 'end', retry: { maxAttempts: 0 } },
      end,
    }),
  },
  {
    code: 'invalid_schema',
    path: ['nodes', 'start', 'schema'],
    definition: definition({
      start: { kind: 'input', next: 'end', schema: { type: 'unsupported' } },
      end,
    }),
  },
]

test.each(fixtures)('$code reports its repair path and hint', (fixture) => {
  const issues = (fixture.graph ?? graph).check(fixture.definition).issues

  const matching = issues.find(
    (item: FlowIssue) =>
      item.code === fixture.code && JSON.stringify(item.path) === JSON.stringify(fixture.path),
  )

  expect(matching, JSON.stringify(issues)).toBeDefined()
  expect(matching?.hint.trim().length).toBeGreaterThan(0)
})

const flowBodyLoop = {
  kind: 'loop',
  maxIterations: 2,
  while: { path: ['input'], is: { isNull: false } },
  body: { flow: 'other', version: 1, input: { a: { value: 1 } } },
  exit: 'end',
}

test('call, goto and flow-body loop pass check', () => {
  const result = graph.check(
    definition({
      start: { kind: 'call', flow: 'other', version: 1, input: { a: { value: 1 } }, next: 'loop' },
      loop: flowBodyLoop,
      handover: { kind: 'goto', flow: 'next', version: 2 },
      end,
    }),
  )

  expect(result.issues.map((item) => item.code)).not.toContain('unsupported')
  expect(result.issues.filter((item) => item.severity === 'error')).toEqual([])
  expect(result.ok).toBe(true)
})

test('call targets are checked', () => {
  const issues = graph.check(
    definition({
      start: { kind: 'call', flow: 'other', next: 'c' },
      c: { kind: 'call', flow: 'other', next: 'missing' },
      end,
    }),
  ).issues

  expect(issues).toContainEqual(
    expect.objectContaining({ code: 'unknown_target', path: ['nodes', 'c', 'next'] }),
  )
})

test('goto satisfies no_end', () => {
  const issues = graph.check(
    definition({
      start: { kind: 'set', assign: [{ path: ['state', 'a'], value: { value: 1 } }], next: 'go' },
      go: { kind: 'goto', flow: 'other' },
    }),
  ).issues

  expect(issues.map((item) => item.code)).not.toContain('no_end')
})

test('flow-body loop has no body edge', () => {
  const result = graph.check(definition({ start: flowBodyLoop, end }))

  expect(result.ok).toBe(true)
  expect(result.issues.map((item) => item.code)).not.toContain('unknown_target')
})

test('call rejects attemptTimeoutMs', () => {
  const issues = graph.check(
    definition({
      start: {
        kind: 'call',
        flow: 'other',
        next: 'end',
        retry: { maxAttempts: 2, attemptTimeoutMs: 1000 },
      },
      end,
    }),
  ).issues

  expect(issues).toContainEqual(
    expect.objectContaining({ code: 'invalid_retry', path: ['nodes', 'start', 'retry'] }),
  )
})

test('call accepts a retry policy without attemptTimeoutMs', () => {
  const result = graph.check(
    definition({
      start: {
        kind: 'call',
        flow: 'other',
        next: 'end',
        retry: { maxAttempts: 2, totalTimeoutMs: 1000 },
      },
      end,
    }),
  )

  expect(result.ok).toBe(true)
})

const resultPathCodes = (producer: FlowNode, path: Array<string>): Array<string> =>
  graph
    .check(
      definition(
        {
          c: producer,
          read: {
            kind: 'set',
            assign: [{ path: ['state', 'x'], value: { ref: path } }],
            next: 'end',
          },
          end,
        },
        'c',
      ),
    )
    .issues.filter((item) => item.severity === 'error')
    .map((item) => item.code)

test('call result paths allow outcome and output subtree only', () => {
  const call = { kind: 'call', flow: 'other', next: 'read' }

  expect(resultPathCodes(call, ['results', 'c', 'output', 'a', 'b'])).toEqual([])
  expect(resultPathCodes(call, ['results', 'c', 'output'])).toEqual([])
  expect(resultPathCodes(call, ['results', 'c', 'outcome'])).toEqual([])
  expect(resultPathCodes(call, ['results', 'c', 'x'])).toEqual(['invalid_result_path'])
})

test('flow-body loop result paths allow outcome and output subtree only', () => {
  const loop = { ...flowBodyLoop, exit: 'read' }

  expect(resultPathCodes(loop, ['results', 'c', 'output', 'a'])).toEqual([])
  expect(resultPathCodes(loop, ['results', 'c', 'outcome'])).toEqual([])
  expect(resultPathCodes(loop, ['results', 'c', 'x'])).toEqual(['invalid_result_path'])
})

test('retryDefaults.call with attemptTimeoutMs throws TypeError', () => {
  expect(() =>
    createFlowGraph({ retryDefaults: { call: { maxAttempts: 2, attemptTimeoutMs: 1000 } } }),
  ).toThrow(TypeError)
  expect(() => createFlowGraph({ retryDefaults: { call: { maxAttempts: 2 } } })).not.toThrow()
})

test.each([
  [
    'call',
    { kind: 'call', flow: 'other', input: { value: { ref: ['results', 'missing'] } }, next: 'end' },
  ],
  ['goto', { kind: 'goto', flow: 'other', input: { value: { ref: ['results', 'missing'] } } }],
  [
    'flow-body loop',
    { ...flowBodyLoop, body: { flow: 'other', input: { value: { ref: ['results', 'missing'] } } } },
  ],
])('%s input key named value is walked for refs', (_name, start) => {
  const issues = graph.check(definition({ start: start as FlowNode, end })).issues

  expect(issues).toContainEqual(
    expect.objectContaining({
      code: 'invalid_path',
      path: [
        'nodes',
        'start',
        ...(_name === 'flow-body loop' ? ['body'] : []),
        'input',
        'value',
        'ref',
      ],
    }),
  )
})
