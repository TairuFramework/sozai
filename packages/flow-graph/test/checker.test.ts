import { expect, test } from 'vitest'

import { createFlowGraph, formatIssues } from '../src/index.js'

const graph = createFlowGraph({ actions: { ok: async () => 1 } })

const base = {
  id: 'example',
  name: 'Example',
  version: 1,
  start: 'start',
  nodes: { start: { kind: 'end' } },
}

test('accepts a minimal graph', () => {
  expect(graph.check(base)).toEqual({ ok: true, issues: [] })
})

test('flags unknown targets with repair paths', () => {
  const issues = graph.check({ ...base, start: 'missing' }).issues

  expect(issues).toContainEqual(
    expect.objectContaining({ code: 'unknown_target', path: ['start'] }),
  )
  expect(issues[0]?.hint).toBeTruthy()
})

test('rejects reserved storage shapes for authoring', () => {
  expect(
    graph
      .check({ ...base, nodes: { start: { kind: 'goto', flow: 'other' } } })
      .issues.map((issue) => issue.code),
  ).toContain('unsupported')
})

test('rejects unsafe paths', () => {
  const definition = {
    ...base,
    nodes: {
      start: {
        kind: 'set',
        assign: [{ path: ['state', '__proto__'], value: { value: 1 } }],
        next: 'end',
      },
      end: { kind: 'end' },
    },
  }

  expect(graph.check(definition).issues.map((issue) => issue.code)).toContain('invalid_path')
})

test('rejects unbounded cycles through exit edges', () => {
  const definition = {
    ...base,
    nodes: {
      start: {
        kind: 'loop',
        maxIterations: 2,
        while: { path: ['input'], is: { isNull: false } },
        body: 'done',
        exit: 'start',
      },
      done: { kind: 'end' },
    },
  }

  expect(graph.check(definition).issues.map((issue) => issue.code)).toContain('unbounded_cycle')
})

test('checks handled error paths for action nodes', () => {
  const definition = {
    ...base,
    nodes: {
      start: { kind: 'action', name: 'ok', next: 'done', onError: 'done' },
      done: {
        kind: 'end',
        output: {
          type: { ref: ['results', 'start', 'error', 'type'] },
          bad: { ref: ['results', 'start', 'error', 'message'] },
        },
      },
    },
  }

  const issues = graph.check(definition).issues

  expect(issues.filter((issue) => issue.code === 'invalid_error_path')).toMatchObject([
    { path: ['nodes', 'done', 'output', 'bad', 'ref'] },
  ])
  expect(
    issues.some(
      (issue) =>
        issue.path.join('.') === 'nodes.done.output.type.ref' &&
        issue.code === 'invalid_error_path',
    ),
  ).toBe(false)
})

test('reports unknown action, invalid retry and invalid nested JSON Schema', () => {
  const definition = {
    ...base,
    nodes: {
      start: { kind: 'action', name: 'missing', next: 'done', retry: { maxAttempts: 0 } },
      done: { kind: 'input', next: 'end', schema: { type: 'not-a-type' } },
      end: { kind: 'end' },
    },
  }

  const codes = graph.check(definition).issues.map((issue) => issue.code)

  expect(codes).toContain('unknown_action')
  expect(codes).toContain('invalid_retry')
  expect(codes).toContain('invalid_schema')
})

test('reports unreachable node and an invalid result producer', () => {
  const definition = {
    ...base,
    nodes: {
      start: { kind: 'end', output: { x: { ref: ['results', 'missing'] } } },
      dead: { kind: 'end' },
    },
  }

  const codes = graph.check(definition).issues.map((issue) => issue.code)

  expect(codes).toContain('unreachable')
  expect(codes).toContain('invalid_path')
})

test('formats actionable issue text for repair loops', () => {
  const text = formatIssues(graph.check({ ...base, start: 'missing' }).issues)

  expect(text).toContain('unknown_target start')
  expect(text).toContain('Fix:')
})

test('malformed nodes return repair issues instead of throwing', () => {
  expect(
    graph.check({ ...base, nodes: { start: null } }).issues.map((issue) => issue.code),
  ).toContain('schema')
  expect(
    graph
      .check({ ...base, nodes: { start: { kind: 'branch', default: 'start' } } })
      .issues.map((issue) => issue.code),
  ).toContain('schema')
})

test('a registered kind with a schema that cannot compile yields invalid_schema', () => {
  const custom = createFlowGraph({
    kinds: [
      {
        kind: 'broken',
        schema: { type: 'unrecognized' } as never,
        targets: () => [],
        execute: () => ({ end: {} }),
      },
    ],
  })

  const result = custom.check({ ...base, nodes: { start: { kind: 'broken' } } })

  expect(result.issues.map((issue) => issue.code)).toContain('invalid_schema')
})
