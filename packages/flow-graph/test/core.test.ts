import { describe, expect, test } from 'vitest'

import { digestDefinition, evaluateFilter, resolveValue } from '../src/index.js'

describe('digest and values', () => {
  test('digests definitions independently of key order', () => {
    expect(digestDefinition({ a: 1, b: 2 })).toBe(digestDefinition({ b: 2, a: 1 }))
    expect(digestDefinition({ a: 1 })).not.toBe(digestDefinition({ a: 2 }))
    expect(() => digestDefinition({ a: Number.NaN })).toThrow(TypeError)
  })
  test('resolves nested refs and missing refs', () => {
    const scope = { input: { x: 2 }, state: {}, results: {}, loops: {} }

    expect(
      resolveValue(
        { object: { a: { ref: ['input', 'x'] }, b: { array: [{ ref: ['state', 'missing'] }] } } },
        scope,
      ),
    ).toEqual({ a: 2, b: [null] })
  })
  test('literal objects never interpret nested ref-like keys', () => {
    const scope = { input: { x: 2 }, state: {}, results: {}, loops: {} }

    expect(resolveValue({ value: { ref: ['input', 'x'] } }, scope)).toEqual({ ref: ['input', 'x'] })
  })
})

describe('filters', () => {
  const scope = {
    input: { x: [1, 2], text: 'hello', empty: [] },
    state: {},
    results: {},
    loops: {},
  }

  test('evaluates deep equality and array inclusion', () => {
    expect(
      evaluateFilter({ path: ['input', 'x'], is: { equalTo: [1, 2], includesAll: [1, 2] } }, scope),
    ).toBe(true)
  })
  test('missing paths are null; non-null comparisons fail', () => {
    expect(evaluateFilter({ path: ['input', 'missing'], is: { isNull: true } }, scope)).toBe(true)
    expect(evaluateFilter({ path: ['input', 'missing'], is: { notEqualTo: 1 } }, scope)).toBe(false)
  })
  test('handles presence and combinators', () => {
    expect(
      evaluateFilter(
        {
          and: [
            { path: ['input', 'empty'], is: { presence: 'empty' } },
            { not: { path: ['input', 'text'], is: { contains: 'no' } } },
          ],
        },
        scope,
      ),
    ).toBe(true)
  })
})
