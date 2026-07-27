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
})
