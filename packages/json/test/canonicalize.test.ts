import { describe, expect, test } from 'vitest'

import { canonicalize } from '../src/index.js'

describe('canonicalize()', () => {
  test('sorts object keys by UTF-16 code unit', () => {
    expect(canonicalize({ z: 1, a: 2, '10': 3, '1': 4 })).toBe('{"1":4,"10":3,"a":2,"z":1}')
  })

  test('sorts a surrogate pair before U+FB33, per code-unit order', () => {
    // U+1F602 leads with 0xD83D, which is below 0xFB33 — code-POINT order would
    // invert these. RFC 8785 section 3.2.3 requires code-unit order.
    const emoji = String.fromCharCode(0xd83d, 0xde02)
    const hebrew = String.fromCharCode(0xfb33)
    expect(canonicalize({ [hebrew]: 1, [emoji]: 2 })).toBe(
      `{${JSON.stringify(emoji)}:2,${JSON.stringify(hebrew)}:1}`,
    )
  })

  test('serializes numbers as JSON.stringify does', () => {
    // biome-ignore lint/correctness/noPrecisionLoss: intentional, verifies rounding matches JSON.stringify
    expect(canonicalize([333333333.33333329, 1e30, 4.5, 2e-3, 1e-27])).toBe(
      '[333333333.3333333,1e+30,4.5,0.002,1e-27]',
    )
  })

  test('returns undefined for non-serializable input', () => {
    expect(canonicalize(undefined)).toBeUndefined()
    expect(canonicalize(() => {})).toBeUndefined()
    expect(canonicalize(Symbol('s'))).toBeUndefined()
  })

  test('omits non-serializable object values and nulls array elements', () => {
    expect(canonicalize({ a: undefined, b: Symbol('s'), c: () => {}, d: 1 })).toBe('{"d":1}')
    expect(canonicalize([undefined, Symbol('s'), () => {}, 1])).toBe('[null,null,null,1]')
  })

  test('emits parseable JSON for a nested function', () => {
    // The regression this package exists for: canonicalize@3.0.0 emitted
    // '{"a":undefined}' here, which JSON.parse rejects.
    const serialized = canonicalize({ a: () => {}, b: 1 }) as string
    expect(serialized).toBe('{"b":1}')
    expect(JSON.parse(serialized)).toEqual({ b: 1 })
  })

  test('omits a key whose toJSON returns undefined', () => {
    expect(canonicalize({ a: { toJSON: () => undefined }, b: 1 })).toBe('{"b":1}')
  })

  test('serializes sparse array holes as null', () => {
    // Built rather than written as `[, 1]`, which biome's noSparseArray rejects.
    const sparse = new Array(2)
    sparse[1] = 1
    expect(canonicalize(sparse)).toBe('[null,1]')
  })

  test('honors toJSON and passes it the property key', () => {
    expect(canonicalize({ d: new Date(0) })).toBe('{"d":"1970-01-01T00:00:00.000Z"}')
    expect(canonicalize({ k: { toJSON: (key: string) => key } })).toBe('{"k":"k"}')
  })

  test('unwraps boxed primitives', () => {
    // Object(x) rather than `new Number(x)`, which biome's wrapper-object rule rejects.
    expect(canonicalize({ a: Object(5) })).toBe('{"a":5}')
    expect(canonicalize({ a: Object('x') })).toBe('{"a":"x"}')
    expect(canonicalize({ a: Object(true) })).toBe('{"a":true}')
  })

  test('reads each property exactly once', () => {
    let reads = 0
    const value = {
      get a() {
        reads++
        return 1
      },
    }
    canonicalize(value)
    expect(reads).toBe(1)
  })

  test('allows a repeated non-circular reference', () => {
    const shared = { v: 1 }
    expect(canonicalize([shared, shared])).toBe('[{"v":1},{"v":1}]')
  })

  test.each([
    ['NaN', { a: Number.NaN }, 'NaN is not allowed'],
    ['Infinity', { a: Number.POSITIVE_INFINITY }, 'Infinity is not allowed'],
    ['-Infinity', { a: Number.NEGATIVE_INFINITY }, 'Infinity is not allowed'],
    ['BigInt', { a: 1n }, 'BigInt is not allowed'],
  ])('throws a TypeError on %s', (_label, value, message) => {
    expect(() => canonicalize(value)).toThrow(TypeError)
    expect(() => canonicalize(value)).toThrow(message)
  })

  test('throws a TypeError on a circular reference', () => {
    const value: Record<string, unknown> = {}
    value.self = value
    expect(() => canonicalize(value)).toThrow(TypeError)
    expect(() => canonicalize(value)).toThrow('Circular reference detected')
  })

  test('throws on a cycle that closes several levels up', () => {
    const root: Record<string, unknown> = {}
    const middle: Record<string, unknown> = {}
    root.middle = middle
    middle.leaf = { root }
    expect(() => canonicalize(root)).toThrow('Circular reference detected')
  })

  test('throws on a cycle through an array', () => {
    const array: Array<unknown> = []
    array.push({ array })
    expect(() => canonicalize(array)).toThrow('Circular reference detected')
  })

  test('throws on a toJSON that returns the value it was called on', () => {
    const value = { toJSON: () => value }
    expect(() => canonicalize(value)).toThrow('Circular reference detected')
  })

  test('allows a reference repeated at different depths', () => {
    // Only passes if a reference stops counting as an ancestor once its subtree is done: the
    // second occurrence is nested deeper than the first, not inside it.
    const shared = { v: 1 }
    expect(canonicalize({ a: shared, b: { c: shared } })).toBe('{"a":{"v":1},"b":{"c":{"v":1}}}')
  })

  test('allows a reference repeated across many siblings', () => {
    const shared = { v: 1 }
    const value = Array.from({ length: 50 }, () => shared)
    expect(canonicalize(value)).toBe(`[${Array.from({ length: 50 }, () => '{"v":1}').join(',')}]`)
  })
})
