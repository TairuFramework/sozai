import { describe, expect, test, vi } from 'vitest'

import {
  assertType,
  asType,
  createStandardValidator,
  createValidator,
  createValidatorFactory,
  isType,
  type Schema,
  toStandardValidator,
  ValidationError,
  ValidationErrorObject,
  type Validator,
} from '../src/index.js'

describe('createValidator()', () => {
  test('creates a schema validation function', () => {
    const validator = createValidator({
      $id: 'test',
      type: 'object',
      properties: { test: { type: 'boolean' } },
      required: ['test'],
      additionalProperties: false,
    } as const)

    expect(assertType(validator, { test: true })).toBeUndefined()
    expect(() => assertType(validator, { test: false, extra: true })).toThrow()
    expect(isType(validator, { test: true })).toBe(true)
    expect(isType(validator, { test: false, extra: true })).toBe(false)

    const validateSuccess = validator({ test: true })
    expect(validateSuccess).toEqual({ value: { test: true } })

    const validateFailure = validator({ test: false, extra: true })
    expect(validateFailure).toBeInstanceOf(ValidationError)
  })

  test('createValidator does not mutate input object', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        role: { type: 'string', default: 'user' },
      },
      required: ['name'],
      additionalProperties: false,
    } as const
    const validator = createValidator(schema)
    const input = { name: 'test' }
    const inputCopy = { ...input }
    validator(input)
    expect(input).toEqual(inputCopy)
  })

  test('a $id-less schema does not wipe the shared instance cache', () => {
    // Schema A registers a $id and an internal $ref on the shared (draft, strict) instance.
    const validateA = createValidator({
      $id: 'https://sozai.test/a',
      type: 'object',
      properties: { child: { $ref: '#/$defs/Child' } },
      $defs: { Child: { type: 'string' } },
      required: ['child'],
      additionalProperties: false,
    } as const)

    // Schema B has no $id — the buggy removeSchema(undefined) would clear A here.
    createValidator({ type: 'object', properties: { n: { type: 'number' } } } as const)

    // A must still validate correctly after B was created.
    expect(validateA({ child: 'ok' })).toEqual({ value: { child: 'ok' } })
    expect(validateA({ child: 1 })).toBeInstanceOf(ValidationError)
  })

  test('memoizes the validator per schema object and options', () => {
    const schema = { type: 'object', properties: { n: { type: 'number' } } } as const

    const a = createValidator(schema)
    const b = createValidator(schema)
    expect(a).toBe(b) // same schema object + default options => same function reference

    const c = createValidator(schema, { draft: '2020-12' })
    expect(c).not.toBe(a) // different options => distinct validator

    const d = createValidator(schema, { strict: undefined })
    expect(d).toBe(a) // strict:undefined collapses to the default cache entry

    // Distinct-but-equal schema objects do not share a cache entry.
    const other = { type: 'object', properties: { n: { type: 'number' } } } as const
    expect(createValidator(other)).not.toBe(a)
  })
})

describe('ValidationErrorObject', () => {
  test('fallback message does not expose schemaPath', () => {
    const errObj = new ValidationErrorObject({
      keyword: 'type',
      instancePath: '/test',
      schemaPath: '#/properties/test/type',
      params: { type: 'string' },
    } as never)
    expect(errObj.message).not.toContain('#/properties')
    expect(errObj.message).toContain('Validation failed')
  })
})

describe('asType()', () => {
  const validator = createValidator({
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  } as const)

  test('returns value when validation passes', () => {
    const input = { name: 'test' }
    const result = asType(validator, input)
    expect(result).toEqual({ name: 'test' })
  })

  test('throws ValidationError when validation fails', () => {
    expect(() => asType(validator, { wrong: true })).toThrow(ValidationError)
  })
})

describe('toStandardValidator()', () => {
  test('wraps validator in StandardSchemaV1 structure', () => {
    const validator = createValidator({
      type: 'object',
      properties: { x: { type: 'number' } },
      required: ['x'],
      additionalProperties: false,
    } as const)

    const standard = toStandardValidator(validator)
    expect(standard['~standard'].version).toBe(1)
    expect(standard['~standard'].vendor).toBe('sozai')
    expect(standard['~standard'].validate).toBe(validator)
  })

  test('standard validate returns value on success', () => {
    const validator = createValidator({
      type: 'object',
      properties: { x: { type: 'number' } },
      required: ['x'],
      additionalProperties: false,
    } as const)

    const standard = toStandardValidator(validator)
    const result = standard['~standard'].validate({ x: 42 })
    expect(result).toEqual({ value: { x: 42 } })
  })

  test('standard validate returns issues on failure', () => {
    const validator = createValidator({
      type: 'object',
      properties: { x: { type: 'number' } },
      required: ['x'],
      additionalProperties: false,
    } as const)

    const standard = toStandardValidator(validator)
    const result = standard['~standard'].validate({ x: 'not a number' })
    expect(result).toBeInstanceOf(ValidationError)
  })
})

describe('ValidatorOptions.strict', () => {
  // A valid 2020-12 construct that AJV strict mode warns about: a prefixItems
  // 2-tuple with no minItems/maxItems.
  const tupleSchema = {
    $id: 'https://example.com/strict-tuple',
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'number' }],
  } as const

  function captureWarnings(fn: () => void): Array<string> {
    const warnings: Array<string> = []
    const original = console.warn
    console.warn = (...args: Array<unknown>) => {
      warnings.push(args.map(String).join(' '))
    }
    try {
      fn()
    } finally {
      console.warn = original
    }
    return warnings
  }

  // AJV's 2020-12 dialect defaults to strictTuples:'log', which logs a warning
  // for prefixItems tuples that lack minItems/maxItems (regression guard).
  test('emits a strict-mode warning by default', () => {
    const warnings = captureWarnings(() => {
      createValidator(tupleSchema, { draft: '2020-12' })
    })
    expect(warnings.some((w) => w.toLowerCase().includes('strict'))).toBe(true)
  })

  test('suppresses the strict-mode warning when strict is false', () => {
    const warnings = captureWarnings(() => {
      createValidator(tupleSchema, { draft: '2020-12', strict: false })
    })
    expect(warnings.some((w) => w.toLowerCase().includes('strict'))).toBe(false)
  })

  test("strict: 'log' still emits the strict-mode warning", () => {
    const warnings = captureWarnings(() => {
      createValidator(tupleSchema, { draft: '2020-12', strict: 'log' })
    })
    expect(warnings.some((w) => w.toLowerCase().includes('strict'))).toBe(true)
  })

  test('caches distinct AJV instances per strict value (no first-call-wins)', () => {
    // Default (strict) first, then strict:false for the same draft. If the cache
    // were keyed by draft only, the second call would reuse the strict instance
    // and still warn.
    captureWarnings(() => {
      createValidator(tupleSchema, { draft: '2020-12' })
    })
    const warnings = captureWarnings(() => {
      createValidator(tupleSchema, { draft: '2020-12', strict: false })
    })
    expect(warnings.some((w) => w.toLowerCase().includes('strict'))).toBe(false)
  })

  test('validates correctly with strict disabled', () => {
    const validate = createValidator(tupleSchema, { draft: '2020-12', strict: false })
    expect(validate(['a', 1])).toEqual({ value: ['a', 1] })
    expect(validate([1, 'a']) instanceof ValidationError).toBe(true)
  })
})

describe('createStandardValidator()', () => {
  test('creates standard validator from schema', () => {
    const standard = createStandardValidator({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    } as const)

    expect(standard['~standard'].version).toBe(1)
    expect(standard['~standard'].vendor).toBe('sozai')

    const result = standard['~standard'].validate({ id: 'abc' })
    expect(result).toEqual({ value: { id: 'abc' } })
  })
})

describe('StandardJSONSchemaV1 converter', () => {
  const schema = {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  } as const

  test('toStandardValidator without a schema has no jsonSchema converter', () => {
    const standard = toStandardValidator(createValidator(schema))
    expect('jsonSchema' in standard['~standard']).toBe(false)
  })

  test('createStandardValidator exposes a jsonSchema converter', () => {
    const standard = createStandardValidator(schema)
    const { jsonSchema } = standard['~standard']
    expect(jsonSchema.input({ target: 'draft-07' })).toEqual(schema)
    expect(jsonSchema.output({ target: 'draft-07' })).toEqual(schema)
  })

  test('input and output return the same document for a plain validator', () => {
    const { jsonSchema } = createStandardValidator(schema)['~standard']
    expect(jsonSchema.input({ target: 'draft-07' })).toBe(jsonSchema.output({ target: 'draft-07' }))
  })

  test('defaults to the draft-07 target', () => {
    const { jsonSchema } = createStandardValidator(schema)['~standard']
    expect(jsonSchema.input({ target: 'draft-07' })).toEqual(schema)
    expect(() => jsonSchema.input({ target: 'draft-2020-12' })).toThrow(
      'Unsupported JSON Schema target: draft-2020-12',
    )
  })

  test('tracks the 2020-12 draft option', () => {
    const { jsonSchema } = createStandardValidator(schema, { draft: '2020-12' })['~standard']
    expect(jsonSchema.input({ target: 'draft-2020-12' })).toEqual(schema)
    expect(() => jsonSchema.input({ target: 'draft-07' })).toThrow(
      'Unsupported JSON Schema target: draft-07',
    )
  })

  test('throws for the openapi-3.0 target', () => {
    const { jsonSchema } = createStandardValidator(schema)['~standard']
    expect(() => jsonSchema.output({ target: 'openapi-3.0' })).toThrow(
      'Unsupported JSON Schema target: openapi-3.0',
    )
  })

  test('toStandardValidator attaches the converter when given a schema', () => {
    const standard = toStandardValidator(createValidator(schema), schema, { draft: '2020-12' })
    expect(standard['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toEqual(schema)
  })
})

describe('ValidationErrorObject path decoding', () => {
  test('decodes JSON Pointer escapes in instancePath', () => {
    // Property name contains a slash and a tilde; Ajv encodes them as ~1 and ~0.
    const validator = createValidator({
      type: 'object',
      properties: { 'a/b~c': { type: 'number' } },
      required: ['a/b~c'],
    } as const)

    const result = validator({ 'a/b~c': 'not-a-number' })
    expect(result).toBeInstanceOf(ValidationError)
    const issue = (result as ValidationError).issues[0]
    expect(issue?.path).toEqual(['a/b~c'])
  })
})

describe('ValidationError getters', () => {
  const schema = {
    $id: 'getter-test',
    type: 'object',
    properties: { count: { type: 'number' } },
    required: ['count'],
    additionalProperties: false,
  } as const
  const validator = createValidator(schema)

  test('issues returns array of ValidationErrorObject', () => {
    const result = validator({ count: 'not a number' })
    expect(result).toBeInstanceOf(ValidationError)
    const error = result as ValidationError
    expect(error.issues.length).toBeGreaterThan(0)
    expect(error.issues[0]).toBeInstanceOf(ValidationErrorObject)
  })

  test('schema returns the original schema', () => {
    const result = validator({ count: 'bad' })
    const error = result as ValidationError
    expect(error.schema).toBe(schema)
  })

  test('value returns the original input', () => {
    const input = { count: 'bad' }
    const result = validator(input)
    const error = result as ValidationError
    expect(error.value).toBe(input)
  })
})

describe('ValidationErrorObject getters', () => {
  test('details returns the original AJV ErrorObject', () => {
    const errObj = new ValidationErrorObject({
      keyword: 'type',
      instancePath: '/foo/bar',
      schemaPath: '#/properties/foo/bar/type',
      params: { type: 'string' },
      message: 'must be string',
    } as never)
    expect(errObj.details.keyword).toBe('type')
    expect(errObj.details.params).toEqual({ type: 'string' })
  })

  test('path returns parsed instance path segments', () => {
    const errObj = new ValidationErrorObject({
      keyword: 'required',
      instancePath: '/deeply/nested/path',
      schemaPath: '#/required',
      params: { missingProperty: 'x' },
      message: 'required',
    } as never)
    expect(errObj.path).toEqual(['deeply', 'nested', 'path'])
  })

  test('path returns empty array for root-level error', () => {
    const errObj = new ValidationErrorObject({
      keyword: 'type',
      instancePath: '',
      schemaPath: '#/type',
      params: { type: 'object' },
      message: 'must be object',
    } as never)
    expect(errObj.path).toEqual([])
  })
})

describe('ValidationError message', () => {
  test('includes the first issue locator in the message', () => {
    const validate = createValidator({
      $id: 'test-schema',
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    } as const)
    let error: unknown
    try {
      assertType(validate, {})
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(ValidationError)
    if (!(error instanceof ValidationError)) throw error
    const message = error.message
    expect(message).toContain('test-schema')
    // root-path normalization: instancePath '' is surfaced as '/' in the message
    expect(message).toMatch(/\(\/ required\)/)
    // .issues must be preserved per spec
    expect(error.issues).toHaveLength(1)
  })
})

describe('JSON Schema 2020-12 support', () => {
  test('validates a 2020-12 prefixItems tuple with { draft: "2020-12" }', () => {
    const validator = createValidator(
      {
        $id: 'tuple2020',
        type: 'array',
        prefixItems: [{ type: 'number' }, { type: 'string' }],
        items: false,
      } as const,
      { draft: '2020-12' },
    )
    expect(isType(validator, [1, 'a'])).toBe(true)
    expect(isType(validator, ['a', 1])).toBe(false)
    expect(isType(validator, [1, 'a', 'extra'])).toBe(false)
  })

  test('applies ajv-formats under the 2020-12 draft', () => {
    const validator = createValidator(
      { $id: 'email2020', type: 'string', format: 'email' } as const,
      { draft: '2020-12' },
    )
    expect(isType(validator, 'user@example.com')).toBe(true)
    expect(isType(validator, 'not-an-email')).toBe(false)
  })

  test('createValidator with the default draft throws on unknown 2020-12 keywords', () => {
    expect(() =>
      createValidator({
        $id: 'tuple07',
        type: 'array',
        prefixItems: [{ type: 'number' }, { type: 'string' }],
        items: false,
      } as const),
    ).toThrow(/unknown keyword/)
  })

  test('reuses the cached 2020-12 instance across validators', () => {
    const first = createValidator(
      {
        $id: 'cacheFirst2020',
        type: 'array',
        prefixItems: [{ type: 'number' }],
        items: false,
      } as const,
      { draft: '2020-12' },
    )
    const second = createValidator(
      {
        $id: 'cacheSecond2020',
        type: 'array',
        prefixItems: [{ type: 'string' }],
        items: false,
      } as const,
      { draft: '2020-12' },
    )
    expect(isType(first, [1])).toBe(true)
    expect(isType(first, ['a'])).toBe(false)
    expect(isType(second, ['a'])).toBe(true)
    expect(isType(second, [1])).toBe(false)
  })

  test('createStandardValidator forwards the draft option', () => {
    const standard = createStandardValidator(
      {
        $id: 'tupleStandard2020',
        type: 'array',
        prefixItems: [{ type: 'number' }],
        items: false,
      } as const,
      { draft: '2020-12' },
    )
    const ok = standard['~standard'].validate([1])
    const bad = standard['~standard'].validate(['x'])
    expect(ok).toEqual({ value: [1] })
    expect(bad).toBeInstanceOf(ValidationError)
  })
})

describe('createValidatorFactory()', () => {
  const objectSchema = (id?: string): Schema => ({
    ...(id != null && { $id: id }),
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  })

  test('creates validators on its own instance', () => {
    const factory = createValidatorFactory()
    const validator = factory.createValidator(objectSchema())

    expect(validator({ name: 'a' })).toEqual({ value: { name: 'a' } })
    expect(validator({})).toBeInstanceOf(ValidationError)
  })

  test('applies the draft option', () => {
    const factory = createValidatorFactory({ draft: '2020-12' })
    const validator = factory.createValidator({
      type: 'array',
      prefixItems: [{ type: 'number' }],
      items: false,
    })

    expect(validator([1])).toEqual({ value: [1] })
    expect(validator([1, 2])).toBeInstanceOf(ValidationError)
  })

  test('applies the strict option', () => {
    const schema = { type: 'object', unknownKeyword: true } as never

    expect(() => createValidatorFactory().createValidator(schema)).toThrow()
    expect(() => createValidatorFactory({ strict: false }).createValidator(schema)).not.toThrow()
  })

  test('shares no schemas with the default instance or other factories', () => {
    const schema = { $id: 'factory-isolated', type: 'string', format: 'email' } as const
    const first = createValidatorFactory()
    const second = createValidatorFactory()

    expect(isType(createValidator(schema), 'a@b.co')).toBe(true)
    expect(isType(first.createValidator({ ...schema }), 'a@b.co')).toBe(true)
    expect(isType(second.createValidator({ ...schema }), 'nope')).toBe(false)
  })

  test('counts compiles, not memoized lookups', () => {
    const factory = createValidatorFactory()
    const schema = objectSchema()

    expect(factory.compiled).toBe(0)
    const validator = factory.createValidator(schema)
    expect(factory.createValidator(schema)).toBe(validator)
    expect(factory.compiled).toBe(1)
    factory.createValidator(objectSchema())
    expect(factory.compiled).toBe(2)
  })

  test('compiles distinct schemas that reuse an $id', () => {
    const factory = createValidatorFactory()
    const first = factory.createValidator(objectSchema('form'))
    const second = factory.createValidator({ $id: 'form', type: 'number' })

    expect(isType(first, { name: 'a' })).toBe(true)
    expect(isType(second, 1)).toBe(true)
  })

  test('dispose rejects new compiles and keeps existing validators working', () => {
    const factory = createValidatorFactory()
    const validator = factory.createValidator(objectSchema())

    factory.dispose()
    factory.dispose()

    expect(() => factory.createValidator(objectSchema())).toThrow('disposed')
    expect(validator({ name: 'a' })).toEqual({ value: { name: 'a' } })
  })

  test('logger false silences unknown format warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const schema = () => ({ type: 'string', format: 'not-a-format' }) as never

    try {
      createValidatorFactory({ strict: false, logger: false }).createValidator(schema())
      expect(warn).not.toHaveBeenCalled()

      createValidatorFactory({ strict: false }).createValidator(schema())
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('routes warnings to a custom logger', () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    createValidatorFactory({ strict: false, logger }).createValidator({
      type: 'string',
      format: 'not-a-format',
    } as never)

    expect(logger.warn).toHaveBeenCalled()
  })
})

type CompilerMaker = (
  draft?: '07' | '2020-12',
) => <TSchema extends Schema>(schema: TSchema) => Validator<unknown>

const compilerMakers: Array<[string, CompilerMaker]> = [
  [
    'createValidator',
    (draft = '07') =>
      (schema) =>
        createValidator(schema, { draft }) as Validator<unknown>,
  ],
  [
    'createValidatorFactory',
    (draft = '07') => {
      const factory = createValidatorFactory({ draft })
      return (schema) => factory.createValidator(schema) as Validator<unknown>
    },
  ],
]

describe.each(compilerMakers)('compile registry cleanup (%s)', (pathName, makeCompiler) => {
  test('failed compile does not block its $id', () => {
    const compile = makeCompiler()
    const $id = `cleanup-failed-${pathName}`
    expect(() => compile({ $id, type: 'string', pattern: '(' })).toThrow()
    const validator = compile({ $id, type: 'string' })
    expect(isType(validator, 'a')).toBe(true)
  })

  test('same root $id, different shapes', () => {
    const compile = makeCompiler()
    const $id = `cleanup-root-${pathName}`
    const first = compile({ $id, type: 'string' })
    const second = compile({ $id, type: 'number' })
    expect(isType(first, 'a')).toBe(true)
    expect(isType(second, 1)).toBe(true)
    expect(isType(second, 'a')).toBe(false)
  })

  test('same nested $id in distinct schemas', () => {
    const compile = makeCompiler()
    const nid = `cleanup-nested-${pathName}`
    const first = compile({ type: 'object', properties: { a: { $id: nid, type: 'string' } } })
    const second = compile({ type: 'object', properties: { b: { $id: nid, type: 'number' } } })
    const asRoot = compile({ $id: nid, type: 'number' })
    expect(isType(asRoot, 1)).toBe(true)
    expect(isType(asRoot, 'x')).toBe(false)
    expect(isType(first, { a: 'x' })).toBe(true)
    expect(isType(first, { a: 1 })).toBe(false)
    expect(isType(second, { b: 1 })).toBe(true)
    expect(isType(second, { b: 'x' })).toBe(false)
  })

  test('internal $ref to definitions', () => {
    const compile = makeCompiler()
    const validator = compile({ definitions: { n: { type: 'number' } }, $ref: '#/definitions/n' })
    expect(isType(validator, 1)).toBe(true)
    expect(isType(validator, 'x')).toBe(false)
  })

  test('recursive root $id', () => {
    const compile = makeCompiler()
    const $id = `cleanup-recursive-${pathName}`
    const validator = compile({ $id, type: 'object', properties: { child: { $ref: $id } } })
    expect(isType(validator, { child: { child: {} } })).toBe(true)
    expect(isType(validator, { child: { child: 1 } })).toBe(false)
  })

  test.each(['07', '2020-12'] as const)('meta-schema alias survives (%s)', (draft) => {
    const compile = makeCompiler(draft)
    const first = compile({ $schema: 'http://json-schema.org/schema', type: 'string' })
    const second = compile({ $schema: 'http://json-schema.org/schema', type: 'string' })
    expect(isType(first, 'a')).toBe(true)
    expect(isType(second, 'a')).toBe(true)
  })

  test('$dynamicRef on 2020-12', () => {
    const compile = makeCompiler('2020-12')
    const first = compile({
      $id: `cleanup-dynamic-a-${pathName}`,
      $dynamicAnchor: 'node',
      type: 'object',
      properties: { child: { $dynamicRef: '#node' } as Schema },
    })
    const second = compile({
      $id: `cleanup-dynamic-b-${pathName}`,
      $dynamicAnchor: 'node',
      type: 'object',
      properties: { child: { $dynamicRef: '#node' } as Schema },
    })
    expect(isType(first, { child: {} })).toBe(true)
    expect(isType(second, { child: {} })).toBe(true)
  })

  describe('reserved $id', () => {
    const cases: Array<['07' | '2020-12', string]> = [
      ['07', 'http://json-schema.org/draft-07/schema'],
      ['2020-12', 'https://json-schema.org/draft/2020-12/schema'],
      ['2020-12', 'https://json-schema.org/draft/2020-12/meta/core'],
    ]
    const variants = cases.flatMap(([draft, base]) =>
      [base, `${base}#`, `${base}#/`].map((id): ['07' | '2020-12', string] => [draft, id]),
    )

    test.each(variants)('rejects %s %s', (draft, $id) => {
      const compile = makeCompiler(draft)
      expect(() => compile({ $id, type: 'string' })).toThrow(`Schema $id ${$id} is reserved`)
      const base = $id.replace(/#\/?$/, '')
      const validator = compile({ $schema: base, type: 'string' })
      expect(isType(validator, 'a')).toBe(true)
    })
  })

  test('earlier validator keeps working', () => {
    const compile = makeCompiler()
    const first = compile({ type: 'string' })
    compile({ type: 'number' })
    expect(isType(first, 'a')).toBe(true)
    expect(isType(first, 1)).toBe(false)
  })
})
