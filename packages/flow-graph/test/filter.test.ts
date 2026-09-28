import type { JSONValue } from '@sozai/json'
import { expect, test } from 'vitest'

import { createFlowGraph, evaluateFilter } from '../src/index.js'

const check = (subject: JSONValue, is: Record<string, unknown>) =>
  evaluateFilter({ path: ['input'], is }, { input: subject, state: {}, results: {}, loops: {} })

test.each([
  [null, { isNull: true }, true],
  [1, { isNull: false }, true],
  [null, { equalTo: 1 }, false],
  [null, { notEqualTo: 1 }, false],
  [2, { notEqualTo: 1 }, true],
  [2, { equalTo: 1 }, false],
  [{ b: 2, a: [1] }, { equalTo: { a: [1], b: 2 } }, true],
  [[1, 2], { equalTo: [2, 1] }, false],
  [2, { in: [1, 2] }, true],
  [2, { notIn: [1, 3] }, true],
  [2, { in: [1, 3] }, false],
  [2, { notIn: [1, 2] }, false],
  [2, { lessThan: 3 }, true],
  [2, { lessThanOrEqualTo: 2 }, true],
  [3, { greaterThan: 2 }, true],
  [2, { greaterThanOrEqualTo: 2 }, true],
  [2, { lessThan: '3' }, false],
  ['a', { lessThan: 'b' }, true],
  ['😀', { lessThan: '\ufb33' }, true],
  ['hello', { contains: 'ell' }, true],
  ['hello', { contains: 'absent' }, false],
  [2, { contains: '2' }, false],
  [[1, 2], { includesAll: [1, 2] }, true],
  [[1, 2], { includesAny: [3, 2] }, true],
  [[1, 2], { includesAll: [1, 3] }, false],
  [[1, 2], { includesAny: [3, 4] }, false],
  [2, { includesAll: [2] }, false],
  [null, { presence: 'null' }, true],
  [1, { presence: 'null' }, false],
  [1, { presence: 'nonNull' }, true],
  [null, { presence: 'nonNull' }, false],
  [[], { presence: 'empty' }, true],
  [1, { presence: 'empty' }, false],
  ['', { presence: 'nullOrEmpty' }, true],
  [null, { presence: 'nullOrEmpty' }, true],
  [{}, { presence: 'nonEmpty' }, true],
  [null, { presence: 'nonEmpty' }, false],
] as Array<[JSONValue, Record<string, unknown>, boolean]>)(
  'evaluates %j with %j',
  (subject, operator, expected) => {
    expect(check(subject, operator)).toBe(expected)
  },
)

test('authoring schema rejects empty filter combinators', () => {
  const graph = createFlowGraph()

  const definition = {
    id: 'f',
    name: 'Filter',
    version: 1,
    start: 'branch',
    nodes: {
      branch: { kind: 'branch', cases: [{ when: { and: [] }, to: 'end' }], default: 'end' },
      end: { kind: 'end' },
    },
  }

  expect(graph.check(definition).issues.map((issue) => issue.code)).toContain('schema')
})

test('combinators and multi-operator leaves use Boolean semantics', () => {
  const scope = { input: 2, state: {}, results: {}, loops: {} }
  const leaf = { path: ['input'], is: { greaterThan: 1, lessThan: 3 } }

  expect(evaluateFilter(leaf, scope)).toBe(true)
  expect(
    evaluateFilter({ and: [leaf, { not: { path: ['input'], is: { equalTo: 3 } } }] }, scope),
  ).toBe(true)
  expect(evaluateFilter({ or: [{ path: ['input'], is: { equalTo: 3 } }, leaf] }, scope)).toBe(true)
  expect(evaluateFilter({ not: leaf }, scope)).toBe(false)
  expect(() => evaluateFilter({ path: ['missing'], is: { equalTo: 1 } }, scope)).not.toThrow()
})

test.each([
  { and: [] },
  { or: [] },
  { path: ['input'], is: {} },
  { path: ['input'], is: { in: [] } },
  { path: ['input'], is: { notIn: [] } },
  { path: ['input'], is: { includesAll: [] } },
  { path: ['input'], is: { includesAny: [] } },
])('authoring schema rejects an empty filter shape %j', (filter) => {
  const graph = createFlowGraph()

  const definition = {
    id: 'empty-filter',
    name: 'Empty filter',
    version: 1,
    start: 'branch',
    nodes: {
      branch: { kind: 'branch', cases: [{ when: filter, to: 'end' }], default: 'end' },
      end: { kind: 'end' },
    },
  }

  expect(graph.check(definition).issues.map((item) => item.code)).toContain('schema')
})
