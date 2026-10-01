import { describe, expect, expectTypeOf, test } from 'vitest'

import { createValidatorCache, type Schema, ValidationError, type Validator } from '../src/index.js'

const str = { type: 'string' } as const
const num = { type: 'number' } as const
const bool = { type: 'boolean' } as const
const broken = { type: 'string', pattern: '(' } as const

function catchError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('Expected a throw')
}

describe('createValidatorCache()', () => {
  test('starts empty', () => {
    expect(createValidatorCache().stats()).toEqual({ generation: 0, compiles: 0, entries: 0 })
  })

  test('reuses one compile for equal schemas', () => {
    const cache = createValidatorCache()
    const first = cache.get({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
    })
    const second = cache.get({
      properties: { a: { type: 'string' } },
      required: ['a'],
      type: 'object',
    })
    expect(second).toBe(first)
    expect(cache.stats().compiles).toBe(1)
  })

  test('array order matters', () => {
    const cache = createValidatorCache()
    cache.get({ type: 'object', required: ['a', 'b'] })
    cache.get({ type: 'object', required: ['b', 'a'] })
    expect(cache.stats()).toMatchObject({ entries: 2, compiles: 2 })
  })

  describe('recycling', () => {
    const cache = createValidatorCache({ maxCompiles: 3 })
    let old: Validator<string>

    test('recycles after maxCompiles', () => {
      old = cache.get(str)
      cache.get(num)
      cache.get(bool)
      cache.get({ type: 'null' })
      expect(cache.stats()).toEqual({ generation: 1, compiles: 1, entries: 1 })
    })

    test('validators outlive recycling', () => {
      expect(old('a')).toEqual({ value: 'a' })
      expect(old(1)).toBeInstanceOf(ValidationError)
    })

    test('previous generation is a miss', () => {
      const fresh = cache.get(str)
      expect(fresh).not.toBe(old)
      expect(cache.stats().compiles).toBe(2)
    })
  })

  test('hit on a full factory does not recycle', () => {
    const cache = createValidatorCache({ maxCompiles: 3 })
    cache.get(str)
    cache.get(num)
    cache.get(bool)
    cache.get(str)
    expect(cache.stats()).toMatchObject({ generation: 0, compiles: 3 })
  })

  test('evicts least recently used', () => {
    const cache = createValidatorCache({ maxEntries: 2 })
    cache.get(str)
    cache.get(num)
    cache.get(str)
    cache.get(bool)
    expect(cache.stats().entries).toBe(2)
    cache.get(str)
    expect(cache.stats().compiles).toBe(3)
    cache.get(num)
    expect(cache.stats().compiles).toBe(4)
  })

  test('caches compile errors', () => {
    const cache = createValidatorCache()
    const first = catchError(() => cache.get(broken))
    expect(first).toBeInstanceOf(Error)
    expect(cache.stats().compiles).toBe(1)
    const second = catchError(() => cache.get({ ...broken }))
    expect(second).toBe(first)
    expect(cache.stats().compiles).toBe(1)
  })

  test('broken schema after recycling', () => {
    const cache = createValidatorCache({ maxCompiles: 1 })
    const first = catchError(() => cache.get(broken))
    cache.get(str)
    const second = catchError(() => cache.get(broken))
    expect(second).not.toBe(first)
    expect(cache.stats()).toEqual({ generation: 2, compiles: 1, entries: 1 })
    const third = catchError(() => cache.get(broken))
    expect(third).toBe(second)
    expect(cache.stats().compiles).toBe(1)
  })

  test('passes factory options', () => {
    const cache = createValidatorCache({ factory: { draft: '2020-12' } })
    const validator = cache.get({
      type: 'array',
      prefixItems: [{ type: 'number' }],
      items: false,
    } as Schema)
    expect(validator([1])).toEqual({ value: [1] })
    expect(validator([1, 2])).toBeInstanceOf(ValidationError)
  })

  test('host-desktop options', () => {
    const cache = createValidatorCache({ factory: { draft: '2020-12', strict: false } })
    expect(() => cache.get({ type: 'object', unknownKeyword: true } as never)).not.toThrow()
  })

  test('boolean schema', () => {
    const cache = createValidatorCache()
    const validator = cache.get(false as unknown as Schema)
    expect(validator(1)).toBeInstanceOf(ValidationError)
    cache.get(false as unknown as Schema)
    expect(cache.stats().compiles).toBe(1)
  })

  test('clear resets', () => {
    const cache = createValidatorCache()
    cache.get(str)
    cache.get(num)
    cache.clear()
    expect(cache.stats()).toEqual({ generation: 0, compiles: 0, entries: 0 })
    cache.get(str)
    expect(cache.stats().compiles).toBe(1)
  })

  test('dispose is terminal', () => {
    const cache = createValidatorCache()
    cache.dispose()
    expect(() => cache.get(str)).toThrow('Validator cache is disposed')
    expect(() => cache.dispose()).not.toThrow()
    expect(() => cache.clear()).not.toThrow()
    expect(() => cache.get(str)).toThrow('Validator cache is disposed')
  })

  test('disposed reflects lifecycle', () => {
    const cache = createValidatorCache()
    expect(cache.disposed).toBe(false)
    cache.clear()
    expect(cache.disposed).toBe(false)
    cache.dispose()
    expect(cache.disposed).toBe(true)
    cache.dispose()
    expect(cache.disposed).toBe(true)
  })

  test('rejects non-JSON schemas', () => {
    const cache = createValidatorCache()
    expect(() =>
      cache.get({ type: 'string', toJSON: () => ({ type: 'number' }) } as never),
    ).toThrow(TypeError)
    expect(() => cache.get({ type: 'string', description: undefined } as never)).toThrow(TypeError)
    expect(cache.stats()).toEqual({ generation: 0, compiles: 0, entries: 0 })
  })

  test('compiles a snapshot', () => {
    const cache = createValidatorCache()
    const schema = {
      type: 'object',
      properties: { z: { type: 'string' }, a: { type: 'string' } },
    } as const
    const result = cache.get(schema)({ z: 1, a: 1 })
    expect(result).toBeInstanceOf(ValidationError)
    const error = result as ValidationError
    expect(error.schema).toEqual(schema)
    expect(error.schema).not.toBe(schema)
    expect(error.issues.map((issue) => issue.path.join('/'))).toEqual(['a', 'z'])
  })

  test('mutated schema object', () => {
    const cache = createValidatorCache()
    const schema: { type: string } = { type: 'string' }
    expect(cache.get(schema as unknown as Schema)('a')).toEqual({ value: 'a' })
    schema.type = 'number'
    const validator = cache.get(schema as unknown as Schema)
    expect(validator(1)).toEqual({ value: 1 })
    expect(validator('a')).toBeInstanceOf(ValidationError)
  })

  test('infers the value type', () => {
    const cache = createValidatorCache()
    expectTypeOf(cache.get(str)).toEqualTypeOf<Validator<string>>()
  })

  test('rejects invalid bounds', () => {
    expect(() => createValidatorCache({ maxCompiles: 0 })).toThrow(RangeError)
    expect(() => createValidatorCache({ maxEntries: 0 })).toThrow(RangeError)
    expect(() => createValidatorCache({ maxCompiles: 1.5 })).toThrow(RangeError)
    expect(() => createValidatorCache({ maxEntries: Number.POSITIVE_INFINITY })).toThrow(RangeError)
  })
})
