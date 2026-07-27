import { describe, expect, test } from 'vitest'

import { parse } from '../src/index.js'

const nest = (depth: number) => '['.repeat(depth) + ']'.repeat(depth)

describe('parse()', () => {
  test('parses ordinary JSON', () => {
    expect(parse('{"a":1,"b":[true,null]}')).toEqual({ a: 1, b: [true, null] })
  })

  test('accepts nesting at the default limit', () => {
    expect(() => parse(nest(128))).not.toThrow()
  })

  test('rejects nesting past the default limit', () => {
    expect(() => parse(nest(129))).toThrow('JSON exceeds maximum nesting depth of 128')
  })

  test('honors a custom maxDepth', () => {
    expect(() => parse(nest(2), { maxDepth: 2 })).not.toThrow()
    expect(() => parse(nest(3), { maxDepth: 2 })).toThrow('JSON exceeds maximum nesting depth of 2')
  })

  test('falls back to the default limit when maxDepth is not finite', () => {
    // `depth > NaN` is always false, so an unvalidated NaN would disable the guard entirely.
    expect(() => parse(nest(129), { maxDepth: Number.NaN })).toThrow(
      'JSON exceeds maximum nesting depth of 128',
    )
    expect(() => parse(nest(128), { maxDepth: Number.NaN })).not.toThrow()
    // Infinity is not finite either, so it falls back rather than disabling the guard.
    expect(() => parse(nest(129), { maxDepth: Number.POSITIVE_INFINITY })).toThrow(
      'JSON exceeds maximum nesting depth of 128',
    )
  })

  test('floors a fractional maxDepth instead of falling back to the default', () => {
    // A finite non-integer must fail closed by flooring, not loosen to the default limit.
    expect(() => parse(nest(1), { maxDepth: 1.5 })).not.toThrow()
    expect(() => parse(nest(2), { maxDepth: 1.5 })).toThrow(
      'JSON exceeds maximum nesting depth of 1',
    )
  })

  test('does not count brackets inside strings', () => {
    expect(parse('{"a":"[[[[["}')).toEqual({ a: '[[[[[' })
  })

  test('does not miscount an escaped quote', () => {
    expect(parse('{"a":"\\"[[["}')).toEqual({ a: '"[[[' })
  })

  test('checks depth before parsing', () => {
    // Invalid JSON past the limit must fail on depth, not on syntax.
    expect(() => parse(`${nest(200)} not json`)).toThrow(
      'JSON exceeds maximum nesting depth of 128',
    )
  })

  describe('protoKeys', () => {
    const payload = '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"ok":1}'

    test.each([
      ['default', undefined],
      ['explicit', { protoKeys: 'allow' } as const],
    ])('allows prototype keys by %s, without polluting', (_label, options) => {
      const result = parse<Record<string, unknown>>(payload, options)
      // JSON.parse creates an ordinary own property and leaves the prototype alone.
      expect(Object.hasOwn(result, '__proto__')).toBe(true)
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })

    test('strips __proto__ and constructor', () => {
      const result = parse<Record<string, unknown>>(payload, { protoKeys: 'strip' })
      expect(Object.hasOwn(result, '__proto__')).toBe(false)
      expect(Object.hasOwn(result, 'constructor')).toBe(false)
      expect(result).toEqual({ ok: 1 })
    })

    test('strips nested prototype keys', () => {
      expect(parse('{"a":{"__proto__":{"x":1},"b":2}}', { protoKeys: 'strip' })).toEqual({
        a: { b: 2 },
      })
    })

    test('leaves array elements alone when stripping', () => {
      expect(parse('[1,2,3]', { protoKeys: 'strip' })).toEqual([1, 2, 3])
    })

    test('strips prototype keys inside an object inside an array', () => {
      // The array path is the one the reviver reaches by numeric key, so a guarded key one level
      // under an array must still be caught.
      expect(parse('[{"__proto__":{"x":1},"ok":1}]', { protoKeys: 'strip' })).toEqual([{ ok: 1 }])
    })

    test.each([
      ['__proto__', '{"__proto__":{}}'],
      ['constructor', '{"constructor":{}}'],
      ['__proto__', '{"a":{"__proto__":{}}}'],
      ['constructor', '{"a":{"constructor":{}}}'],
      ['__proto__', '[{"__proto__":{"x":1},"ok":1}]'],
      ['constructor', '[{"constructor":{},"ok":1}]'],
    ])('rejects %s in %s', (key, json) => {
      expect(() => parse(json, { protoKeys: 'reject' })).toThrow(TypeError)
      expect(() => parse(json, { protoKeys: 'reject' })).toThrow(`Forbidden key: ${key}`)
    })

    test('accepts a payload with no prototype keys when rejecting', () => {
      expect(parse('{"a":1}', { protoKeys: 'reject' })).toEqual({ a: 1 })
    })
  })
})
