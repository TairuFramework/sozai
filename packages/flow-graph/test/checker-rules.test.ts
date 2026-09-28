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
    code: 'unsupported',
    path: ['nodes', 'start'],
    definition: definition({ start: { kind: 'goto', flow: 'other' } }),
  },
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
