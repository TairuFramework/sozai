import { describe, expect, test } from 'vitest'

import { isJSONValue, toJSONValue } from '../src/index.js'

describe('toJSONValue()', () => {
  test('preserves plain JSON values', () => {
    for (const value of [null, true, false, 0, 1.5, 'text', [], {}, { a: [1, { b: null }] }]) {
      expect(toJSONValue(value)).toEqual(value)
      expect(isJSONValue(toJSONValue(value))).toBe(true)
    }
  })

  test('coerces unsupported scalars without losing sibling properties', () => {
    const fn = () => 1
    expect(toJSONValue({ good: { a: 1 }, bigint: 2n, symbol: Symbol('s'), fn })).toEqual({
      good: { a: 1 },
      bigint: '2',
      symbol: 'Symbol(s)',
      fn: String(fn),
    })
    expect(toJSONValue([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).toEqual([
      null,
      null,
      null,
    ])
  })

  test('omits undefined properties and preserves array positions', () => {
    expect(toJSONValue(undefined)).toBe('undefined')
    expect(toJSONValue({ a: undefined, b: 1 })).toEqual({ b: 1 })
    expect(toJSONValue(Array(2))).toEqual([null, null])
    expect(toJSONValue([undefined, 1])).toEqual([null, 1])
  })

  test('uses toJSON output recursively and supplies property keys', () => {
    const custom = { toJSON: (key: string) => ({ key, value: 1n }) }
    expect(toJSONValue(new Date(0))).toBe('1970-01-01T00:00:00.000Z')
    expect(toJSONValue(new Date(Number.NaN))).toBeNull()
    expect(toJSONValue(custom)).toEqual({ key: '', value: '1' })
    expect(toJSONValue({ custom })).toEqual({ custom: { key: 'custom', value: '1' } })
    expect(toJSONValue([custom])).toEqual([{ key: '0', value: '1' }])
    const missing = { toJSON: () => undefined }
    expect(toJSONValue({ missing })).toEqual({})
    expect(toJSONValue([missing])).toEqual([null])
    expect(toJSONValue(missing)).toBe('undefined')
  })

  test('marks ancestor cycles while preserving shared references', () => {
    const shared = { value: 1 }
    const circular: Record<string, unknown> = { shared }
    circular.self = circular
    expect(toJSONValue([shared, shared, circular])).toEqual([
      shared,
      shared,
      { shared, self: '[circular]' },
    ])
    const array: Array<unknown> = []
    array.push(array)
    expect(toJSONValue(array)).toEqual(['[circular]'])
  })

  test('handles toJSON returning itself or an ancestor', () => {
    const self = {
      value: 1,
      toJSON() {
        return this
      },
    }
    expect(toJSONValue(self)).toEqual({ value: 1, toJSON: String(self.toJSON) })
    const parent: Record<string, unknown> = {}
    parent.child = { toJSON: () => parent }
    expect(toJSONValue(parent)).toEqual({ child: '[circular]' })
  })

  test('keeps throwing getters visible and reads other getters once', () => {
    let reads = 0
    const value = {
      get bad() {
        throw new Error('getter failed')
      },

      get good() {
        reads++
        return { value: 1n }
      },
    }
    expect(toJSONValue(value)).toEqual({ bad: 'Error: getter failed', good: { value: '1' } })
    expect(reads).toBe(1)
    const array = Object.defineProperty([1, 2], '0', {
      get() {
        throw 'array getter failed'
      },
    })
    expect(toJSONValue(array)).toEqual(['array getter failed', 2])
  })

  test('guards failed toJSON and string conversion', () => {
    const value = {
      toJSON() {
        throw new Error('bad JSON')
      },

      toString() {
        return 'visible'
      },
    }
    expect(toJSONValue({ value, good: 1 })).toEqual({ value: 'visible', good: 1 })
    const hostile = {
      toJSON() {
        throw null
      },

      [Symbol.toPrimitive]() {
        throw null
      },
    }
    expect(toJSONValue(hostile)).toBe('[unrenderable]')
    expect(
      toJSONValue({
        get bad() {
          throw hostile
        },
      }),
    ).toEqual({ bad: '[unrenderable]' })
  })

  test('guards proxies that fail enumeration or property access', () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(toJSONValue({ revoked: revoked.proxy, good: 1 })).toEqual({
      revoked: '[unrenderable]',
      good: 1,
    })
    const value = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('keys failed')
        },
      },
    )
    expect(toJSONValue(value)).toBe('[object Object]')
  })

  test('unwraps boxed primitives and ignores non-enumerable and symbol keys', () => {
    expect(toJSONValue([new Number(1), new String('a'), new Boolean(false)])).toEqual([
      1,
      'a',
      false,
    ])
    const value = Object.create(null)
    value.a = 1
    value[Symbol('hidden')] = 2
    Object.defineProperty(value, 'hidden', { value: 3 })
    expect(toJSONValue(value)).toEqual({ a: 1 })
  })

  test('preserves __proto__ as an own data property', () => {
    const value = JSON.parse('{"__proto__":{"safe":true},"constructor":1}')
    const result = toJSONValue(value)
    expect(result).toEqual(value)
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.hasOwn(result as object, '__proto__')).toBe(true)
  })
})
