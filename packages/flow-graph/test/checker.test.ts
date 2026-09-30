import type { Schema } from '@sozai/schema'
import { expect, test, vi } from 'vitest'

import { checkDefinition, createFlowGraph, defineNodeKind, formatIssues } from '../src/index.js'
import { failedIssues, passedWarnings, reportedIssues } from './check-result.js'

const graph = createFlowGraph({ actions: { ok: async () => 1 } })

const base = {
  id: 'example',
  name: 'Example',
  version: 1,
  start: 'start',
  nodes: { start: { kind: 'end' } },
}

test('accepts a minimal graph', () => {
  expect(graph.check(base)).toEqual({ value: base, warnings: [] })
})

test('a definition without nodes fails with an issue even without an authoring schema', () => {
  const result = checkDefinition({ definition: { id: 'x', start: 's' }, kinds: new Map() })

  expect(failedIssues(result).map((item) => [item.code, item.path])).toEqual([
    ['schema', ['nodes']],
  ])
})

test('a passing check returns the definition with its warnings and no issues', () => {
  const definition = { ...base, nodes: { start: { kind: 'end' }, orphan: { kind: 'end' } } }
  const result = graph.check(definition)

  expect(result).toStrictEqual({
    value: definition,
    warnings: [expect.objectContaining({ code: 'unreachable', severity: 'warning' })],
  })
  expect(result.issues).toBeUndefined()
})

test('a failing check returns every issue, warnings included, in order', () => {
  const result = graph.check({
    ...base,
    start: 'missing',
    nodes: { start: { kind: 'end' }, orphan: { kind: 'end' } },
  })

  expect(result).not.toHaveProperty('value')
  expect(failedIssues(result).map((item) => [item.code, item.severity])).toEqual(
    expect.arrayContaining([
      ['unknown_target', 'error'],
      ['unreachable', 'warning'],
    ]),
  )
})

test('flags unknown targets with repair paths', () => {
  const issues = reportedIssues(graph.check({ ...base, start: 'missing' }))

  expect(issues).toContainEqual(
    expect.objectContaining({ code: 'unknown_target', path: ['start'] }),
  )
  expect(issues[0]?.hint).toBeTruthy()
})

test('accepts reference nodes for authoring', () => {
  const result = graph.check({ ...base, nodes: { start: { kind: 'goto', flow: 'other' } } })

  expect(passedWarnings(result).map((issue) => issue.code)).not.toContain('unsupported')
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

  expect(reportedIssues(graph.check(definition)).map((issue) => issue.code)).toContain(
    'invalid_path',
  )
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

  expect(reportedIssues(graph.check(definition)).map((issue) => issue.code)).toContain(
    'unbounded_cycle',
  )
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

  const issues = reportedIssues(graph.check(definition))

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

  const codes = reportedIssues(graph.check(definition)).map((issue) => issue.code)

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

  const codes = reportedIssues(graph.check(definition)).map((issue) => issue.code)

  expect(codes).toContain('unreachable')
  expect(codes).toContain('invalid_path')
})

test('formats actionable issue text for repair loops', () => {
  const text = formatIssues(reportedIssues(graph.check({ ...base, start: 'missing' })))

  expect(text).toContain('unknown_target start')
  expect(text).toContain('Fix:')
})

test('malformed nodes return repair issues instead of throwing', () => {
  expect(
    reportedIssues(graph.check({ ...base, nodes: { start: null } })).map((issue) => issue.code),
  ).toContain('schema')
  expect(
    reportedIssues(
      graph.check({ ...base, nodes: { start: { kind: 'branch', default: 'start' } } }),
    ).map((issue) => issue.code),
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

  expect(failedIssues(result).map((issue) => issue.code)).toContain('invalid_schema')
})

const resultPathGraph = (resultSchema: unknown) =>
  createFlowGraph({
    kinds: [
      defineNodeKind({
        kind: 'tool',
        schema: {
          type: 'object',
          required: ['kind', 'next'],
          properties: { kind: { const: 'tool' }, next: { type: 'string' } },
          additionalProperties: false,
        },
        targets: (node: { kind: 'tool'; next: string }) => [{ path: ['next'], id: node.next }],
        resultSchema: () => resultSchema as Schema,
        execute: (node) => ({ next: node.next, result: {} }),
      }),
    ],
  })

const resultPathCodes = (resultSchema: unknown, path: Array<string>): Array<string> =>
  reportedIssues(
    resultPathGraph(resultSchema).check({
      ...base,
      nodes: {
        start: { kind: 'tool', next: 'end' },
        end: { kind: 'end', output: { value: { ref: ['results', 'start', ...path] } } },
      },
    }),
  ).map((item) => item.code)

test('result path under true or {} is accepted at any depth', () => {
  const path = ['a', 'b', 'c', '0', 'd']

  expect(resultPathCodes(true, path)).not.toContain('invalid_result_path')
  expect(resultPathCodes({}, path)).not.toContain('invalid_result_path')
})

test('annotation-only result schema is unconstrained', () => {
  expect(resultPathCodes({ description: 'any' }, ['a', 'b'])).not.toContain('invalid_result_path')
})

test('additionalProperties true accepts unknown keys at depth', () => {
  expect(resultPathCodes({ type: 'object', additionalProperties: true }, ['x', 'y'])).not.toContain(
    'invalid_result_path',
  )
})

test('recursive local $ref accepts deep paths', () => {
  const schema = {
    $ref: '#/definitions/node',
    definitions: {
      node: { type: 'object', additionalProperties: { $ref: '#/definitions/node' } },
    },
  }

  expect(
    resultPathCodes(
      schema,
      Array.from({ length: 40 }, (_, index) => `k${index}`),
    ),
  ).not.toContain('invalid_result_path')
})

test('properties without type and patternProperties still constrain', () => {
  expect(resultPathCodes({ properties: { a: {} } }, ['b'])).toContain('invalid_result_path')
  expect(resultPathCodes({ patternProperties: { '^x': {} } }, ['x1'])).toContain(
    'invalid_result_path',
  )
})

test('unresolvable $ref fails the path', () => {
  expect(resultPathCodes({ $ref: '#/definitions/missing' }, ['a'])).toContain('invalid_result_path')
})

test('path-only result schemas compile without strict mode warnings', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  expect(
    resultPathCodes({ properties: { a: { additionalProperties: { properties: {} } } } }, [
      'a',
      'b',
    ]),
  ).not.toContain('invalid_schema')
  expect(warn).not.toHaveBeenCalled()
})
