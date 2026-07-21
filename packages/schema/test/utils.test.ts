import { describe, expect, test } from 'vitest'

import type { Schema } from '../src/types.js'
import { resolveReference, resolveSchema } from '../src/utils.js'

describe('resolveReference()', () => {
  const root = {
    type: 'object',
    properties: {
      name: { type: 'string' },
    },
    $defs: {
      Address: {
        type: 'object',
        properties: {
          street: { type: 'string' },
        },
      },
    },
  } as unknown as Schema

  test('resolves a valid $ref path', () => {
    const result = resolveReference(root, '#/$defs/Address')
    expect(result).toEqual({
      type: 'object',
      properties: {
        street: { type: 'string' },
      },
    })
  })

  test('throws for ref not starting with #', () => {
    expect(() => resolveReference(root, 'other/path')).toThrow('Invalid reference format')
  })

  test('throws for ref pointing to a key that is not an own property', () => {
    // With own-property-only traversal, a genuinely absent key is rejected by the
    // Object.hasOwn() check (same guard used for prototype-pollution segments),
    // before the old null-check would have run.
    expect(() => resolveReference(root, '#/$defs/Missing')).toThrow('Invalid reference segment')
  })

  test('throws "Reference not found" when an own property resolves to null', () => {
    const schema = {
      $defs: { Nullable: null },
    } as unknown as Schema
    expect(() => resolveReference(schema, '#/$defs/Nullable')).toThrow('Reference not found')
  })

  test('throws for ref traversing through non-object', () => {
    const schema: Schema = {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 100 },
      },
    }
    expect(() => resolveReference(schema, '#/properties/name/maxLength/deep')).toThrow(
      'Invalid reference path',
    )
  })

  test('rejects __proto__ segment (prototype pollution)', () => {
    expect(() => resolveReference(root, '#/__proto__/polluted')).toThrow(
      'Invalid reference segment',
    )
  })

  test('rejects constructor segment (prototype pollution)', () => {
    expect(() => resolveReference(root, '#/constructor/prototype')).toThrow(
      'Invalid reference segment',
    )
  })

  test('rejects prototype segment (prototype pollution)', () => {
    expect(() => resolveReference(root, '#/prototype/something')).toThrow(
      'Invalid reference segment',
    )
  })

  test('rejects toString segment (inherited method access)', () => {
    expect(() => resolveReference(root, '#/toString/something')).toThrow(
      'Invalid reference segment',
    )
  })

  test('rejects valueOf segment (inherited method access)', () => {
    expect(() => resolveReference(root, '#/valueOf/something')).toThrow('Invalid reference segment')
  })

  test('resolves an own property named like an inherited method (toString)', () => {
    const schema = {
      type: 'object',
      properties: { toString: { type: 'string' } },
    } as unknown as Schema
    expect(resolveReference(schema, '#/properties/toString')).toEqual({ type: 'string' })
  })

  test('resolves a $ref with an escaped slash in the key (~1)', () => {
    const schema = {
      $defs: { 'a/b': { type: 'string' } },
    } as unknown as Schema
    expect(resolveReference(schema, '#/$defs/a~1b')).toEqual({ type: 'string' })
  })

  test('resolves a $ref with a percent-encoded segment', () => {
    const schema = {
      $defs: { 'a b': { type: 'string' } },
    } as unknown as Schema
    expect(resolveReference(schema, '#/$defs/a%20b')).toEqual({ type: 'string' })
  })

  test('rejects a malformed percent-encoded segment with a normal error', () => {
    const schema = { $defs: {} } as unknown as Schema
    // A lone `%` is not a valid percent-escape; decodeURIComponent would throw a
    // raw URIError — the traversal must surface its own Error shape instead.
    expect(() => resolveReference(schema, '#/$defs/%')).toThrow('Invalid reference segment')
  })
})

describe('resolveSchema()', () => {
  test('returns schema as-is when no $ref', () => {
    const schema: Schema = { type: 'string' }
    expect(resolveSchema({}, schema)).toBe(schema)
  })

  test('resolves schema with $ref', () => {
    const root = {
      $defs: {
        Name: { type: 'string', maxLength: 100 },
      },
    } as unknown as Schema
    const schema: Schema = { $ref: '#/$defs/Name' }
    expect(resolveSchema(root, schema)).toEqual({ type: 'string', maxLength: 100 })
  })
})
