import { describe, expect, test } from 'vitest'

import { canonicalizeJSON, isJSONValue } from '../src/index.js'

describe('isJSONValue()', () => {
  test('accepts JSON values', () => {
    expect(isJSONValue(null)).toBe(true)
    expect(isJSONValue(true)).toBe(true)
    expect(isJSONValue(0)).toBe(true)
    expect(isJSONValue('text')).toBe(true)
    expect(isJSONValue([1, 'a', null, { b: [false] }])).toBe(true)
    expect(isJSONValue({ a: { b: [1, 2] } })).toBe(true)
    expect(isJSONValue(Object.create(null))).toBe(true)
  })

  test('accepts a value repeated across siblings', () => {
    const shared = { a: 1 }
    expect(isJSONValue([shared, shared])).toBe(true)
  })

  test('rejects non-finite numbers', () => {
    expect(isJSONValue(Number.NaN)).toBe(false)
    expect(isJSONValue([Number.POSITIVE_INFINITY])).toBe(false)
    expect(isJSONValue({ a: Number.NEGATIVE_INFINITY })).toBe(false)
  })

  test('rejects values without a JSON representation', () => {
    expect(isJSONValue(undefined)).toBe(false)
    expect(isJSONValue(() => {})).toBe(false)
    expect(isJSONValue(Symbol('s'))).toBe(false)
    expect(isJSONValue(1n)).toBe(false)
    expect(isJSONValue({ a: undefined })).toBe(false)
  })

  test('rejects class instances and toJSON objects', () => {
    expect(isJSONValue(new Date(0))).toBe(false)
    expect(isJSONValue(new Map())).toBe(false)
    expect(isJSONValue({ toJSON: () => 1 })).toBe(false)
  })

  test('rejects sparse arrays and extra array properties', () => {
    // biome-ignore lint/suspicious/noSparseArray: testing holes
    expect(isJSONValue([1, , 3])).toBe(false)
    const array: Array<number> & { extra?: number } = [1]
    array.extra = 2
    expect(isJSONValue(array)).toBe(false)
    // biome-ignore lint/suspicious/noSparseArray: testing holes
    const sparse: Array<number | undefined> & { extra?: number } = [1, , 3]
    sparse.extra = 2
    expect(isJSONValue(sparse)).toBe(false)
  })

  test('rejects symbol keys, accessors and non-enumerable properties', () => {
    expect(isJSONValue({ [Symbol('s')]: 1 })).toBe(false)
    expect(
      isJSONValue({
        get a() {
          return 1
        },
      }),
    ).toBe(false)
    expect(isJSONValue(Object.defineProperty({}, 'a', { value: 1, enumerable: false }))).toBe(false)
  })

  test('rejects circular references', () => {
    const object: Record<string, unknown> = {}
    object.self = object
    expect(isJSONValue(object)).toBe(false)
  })
})

describe('canonicalizeJSON()', () => {
  test('serializes canonically', () => {
    expect(canonicalizeJSON({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}')
  })

  test('throws on a non-JSON value', () => {
    expect(() => canonicalizeJSON({ a: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalizeJSON(new Date(0) as never)).toThrow(TypeError)
  })
})
