import { describe, expect, test } from 'vitest'

import type { Schema } from '../src/types.js'
import { rebaseDefinitionReferences } from '../src/utils.js'
import { createValidator, isType } from '../src/validation.js'

// Unit cases use loose shapes (and literal data) that are not typed JSON schemas.
function rebase<T>(schema: T): T {
  return rebaseDefinitionReferences(schema as Schema) as T
}

const jsonDefinitions = {
  json: {
    anyOf: [
      { type: 'null' },
      { type: 'boolean' },
      { type: 'number' },
      { type: 'string' },
      { type: 'array', items: { $ref: '#/definitions/json' } },
      { type: 'object', additionalProperties: { $ref: '#/definitions/json' } },
    ],
  },
} as const

const recursiveSchema = {
  type: 'object',
  properties: { value: { $ref: '#/definitions/json' } },
  required: ['value'],
  additionalProperties: false,
  definitions: jsonDefinitions,
} as const satisfies Schema

function embed(schema: Schema): Schema {
  return {
    type: 'object',
    properties: { header: { type: 'string' }, payload: schema },
    required: ['header', 'payload'],
    additionalProperties: false,
  }
}

describe('rebaseDefinitionReferences()', () => {
  test('embedded root-local references fail to resolve without rebasing', () => {
    expect(() => createValidator(embed(recursiveSchema))).toThrow(/can't resolve reference/)
  })

  test('validates recursive values once the embedding schema is rebased', () => {
    const validator = createValidator(rebaseDefinitionReferences(embed(recursiveSchema)))
    const value = { a: [1, 'two', { b: [null, true, { c: [] }] }] }
    expect(isType(validator, { header: 'h', payload: { value } })).toBe(true)
    expect(isType(validator, { header: 'h', payload: { value: { a: [() => {}] } } })).toBe(false)
  })

  test('validates with a root $id on the rebased schema', () => {
    const schema = rebaseDefinitionReferences({ anyOf: [embed(recursiveSchema)] })
    const validator = createValidator({ ...schema, $id: 'rebased-with-id' })
    expect(isType(validator, { header: 'h', payload: { value: [[['deep']]] } })).toBe(true)
  })

  test('validates values using pointer-escaped definition names', () => {
    const validator = createValidator(
      rebaseDefinitionReferences(
        embed({
          type: 'object',
          properties: { value: { $ref: '#/definitions/a~1b~0c' } },
          required: ['value'],
          definitions: { 'a/b~c': { type: 'string' } },
        }),
      ),
    )
    expect(isType(validator, { header: 'h', payload: { value: 'x' } })).toBe(true)
    expect(isType(validator, { header: 'h', payload: { value: 1 } })).toBe(false)
  })

  test('validates literal $ref data with a const schema', () => {
    const literal = { $ref: '#/definitions/json' }
    const validator = createValidator(
      rebaseDefinitionReferences(
        embed({
          type: 'object',
          properties: { ref: { const: literal } },
          required: ['ref'],
          definitions: jsonDefinitions,
        }),
      ),
    )
    expect(isType(validator, { header: 'h', payload: { ref: literal } })).toBe(true)
  })

  test('does not mutate the source schema', () => {
    const source = structuredClone(recursiveSchema)
    rebaseDefinitionReferences(embed(recursiveSchema))
    expect(recursiveSchema).toEqual(source)
  })

  test('rebases references against the nearest definition scope', () => {
    const schema = {
      properties: {
        outer: {
          definitions: { item: { type: 'string' } },
          properties: {
            inner: {
              definitions: { item: { type: 'number' } },
              items: { $ref: '#/definitions/item' },
            },
            other: { $ref: '#/definitions/item' },
          },
        },
      },
    }
    expect(rebase(schema)).toEqual({
      properties: {
        outer: {
          definitions: { item: { type: 'string' } },
          properties: {
            inner: {
              definitions: { item: { type: 'number' } },
              items: { $ref: '#/properties/outer/properties/inner/definitions/item' },
            },
            other: { $ref: '#/properties/outer/definitions/item' },
          },
        },
      },
    })
  })

  test('falls back to an outer scope when the nearest one lacks the name', () => {
    const schema = {
      anyOf: [
        {
          $defs: { a: { type: 'string' } },
          properties: {
            nested: { $defs: { b: { type: 'number' } }, $ref: '#/$defs/a' },
          },
        },
      ],
    }
    const rebased = rebase(schema)
    expect(rebased.anyOf[0]?.properties.nested.$ref).toBe('#/anyOf/0/$defs/a')
  })

  test('handles pointer-escaped definition names and trailing pointer segments', () => {
    const schema = {
      properties: {
        payload: {
          definitions: { 'a/b~c': { properties: { x: { type: 'string' } } } },
          properties: {
            whole: { $ref: '#/definitions/a~1b~0c' },
            part: { $ref: '#/definitions/a~1b~0c/properties/x' },
          },
        },
      },
    }
    const rebased = rebase(schema)
    expect(rebased.properties.payload.properties.whole.$ref).toBe(
      '#/properties/payload/definitions/a~1b~0c',
    )
    expect(rebased.properties.payload.properties.part.$ref).toBe(
      '#/properties/payload/definitions/a~1b~0c/properties/x',
    )
  })

  test('escapes property names containing pointer characters in rebased paths', () => {
    const schema = {
      properties: {
        'a/b': {
          definitions: { item: { type: 'string' } },
          items: { $ref: '#/definitions/item' },
        },
      },
    }
    const rebased = rebase(schema)
    expect(rebased.properties['a/b'].items.$ref).toBe('#/properties/a~1b/definitions/item')
  })

  test('keeps $id resources, external and unknown references unchanged', () => {
    const resource = {
      $id: 'urn:resource',
      definitions: { item: { type: 'string' } },
      items: { $ref: '#/definitions/item' },
    }
    const schema = {
      definitions: { known: { type: 'string' } },
      properties: {
        resource,
        external: { $ref: 'urn:other#/definitions/item' },
        missing: { $ref: '#/definitions/missing' },
        root: { $ref: '#' },
        property: { $ref: '#/properties/resource' },
        known: { $ref: '#/definitions/known' },
      },
    }
    const rebased = rebase(schema)
    expect(rebased.properties.resource).toBe(resource)
    expect(rebased.properties.external.$ref).toBe('urn:other#/definitions/item')
    expect(rebased.properties.missing.$ref).toBe('#/definitions/missing')
    expect(rebased.properties.root.$ref).toBe('#')
    expect(rebased.properties.property.$ref).toBe('#/properties/resource')
    expect(rebased.properties.known.$ref).toBe('#/definitions/known')
  })

  test('keeps literal data unchanged', () => {
    const literal = { $ref: '#/definitions/item' }
    const schema = {
      properties: {
        payload: {
          definitions: { item: { type: 'string' } },
          const: literal,
          enum: [literal],
          default: literal,
          examples: [literal],
          'x-extension': { properties: { a: literal } },
          properties: { value: { $ref: '#/definitions/item', default: literal } },
        },
      },
    }
    const rebased = rebase(schema)
    const payload = rebased.properties.payload
    expect(payload.const).toBe(literal)
    expect(payload.enum[0]).toBe(literal)
    expect(payload.default).toBe(literal)
    expect(payload.examples[0]).toBe(literal)
    expect(payload['x-extension']).toBe(schema.properties.payload['x-extension'])
    expect(payload.properties.value).toEqual({
      $ref: '#/properties/payload/definitions/item',
      default: literal,
    })
  })
})
