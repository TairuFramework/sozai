import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import { Ajv } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { FromSchema } from 'json-schema-to-ts'

import { ValidationError } from './errors.js'
import type { Schema } from './types.js'

/**
 * Options for creating a validator.
 */
export type ValidatorOptions = { draft?: '07' | '2020-12'; strict?: boolean | 'log' }

/**
 * Logger receiving AJV warnings, such as unknown formats under non-strict mode.
 */
export type ValidatorLogger = {
  log: (...args: Array<unknown>) => unknown
  warn: (...args: Array<unknown>) => unknown
  error: (...args: Array<unknown>) => unknown
}

/**
 * Options for creating a validator factory. `logger: false` silences AJV warnings.
 */
export type ValidatorFactoryOptions = ValidatorOptions & { logger?: ValidatorLogger | false }

/**
 * Validator factory owning an isolated AJV instance.
 */
export type ValidatorFactory = {
  /** Create a validator on this factory's instance, memoized per schema object. */
  createValidator: <S extends Schema, T = FromSchema<S>>(schema: S) => Validator<T>
  /** Number of schemas compiled, excluding memoized lookups. */
  readonly compiled: number
  /**
   * Drop the AJV instance and every validator memoized on it. Later `createValidator` calls
   * throw. Validators already returned keep working and keep the instance alive until they
   * are dropped too. Idempotent.
   */
  dispose: () => void
}

// AJV instances are locked to a single dialect AND a single strict setting, so
// we cache one instance per (draft, strict) pair and construct them lazily.
const instances = new Map<string, AjvContext>()

// Memoize compiled validators per schema object, keyed by normalized options.
// WeakMap lets entries be collected when the schema object is. Keying by object
// identity means a schema mutated in place after its first `createValidator` call
// keeps returning the validator compiled from the ORIGINAL shape; pass a fresh
// object to recompile. Schemas are expected to be immutable (`as const`) literals.
const validators = new WeakMap<Schema, Map<string, Validator<unknown>>>()

type AjvInstance = Ajv | Ajv2020

// An AJV instance with the keys of everything registered on it after setup (meta-schemas and
// their aliases), so a compile can remove whatever it added and nothing else.
type AjvContext = { ajv: AjvInstance; baseline: ReadonlySet<string> }

type CreateAjvParams = {
  draft: '07' | '2020-12'
  strict?: boolean | 'log'
  logger?: ValidatorLogger | false
}

function createAjv(params: CreateAjvParams): AjvContext {
  const { draft, strict, logger } = params
  const options = {
    allErrors: true,
    useDefaults: false,
    ...(strict !== undefined && { strict }),
    ...(logger !== undefined && { logger }),
  }
  const instance = draft === '2020-12' ? new Ajv2020(options) : new Ajv(options)
  // @ts-expect-error missing type definition
  addFormats(instance)
  const baseline = new Set([...Object.keys(instance.schemas), ...Object.keys(instance.refs)])
  return { ajv: instance, baseline }
}

function getAjv(draft: '07' | '2020-12', strict?: boolean | 'log'): AjvContext {
  const key = `${draft}:${strict ?? 'default'}`
  let context = instances.get(key)
  if (context == null) {
    context = createAjv({ draft, strict })
    instances.set(key, context)
  }
  return context
}

// Compile `schema` on the context's instance and wrap the result as a `Validator`.
function compileValidator<T>(context: AjvContext, schema: Schema): Validator<T> {
  const { ajv, baseline } = context
  if (typeof schema === 'object' && typeof schema.$id === 'string') {
    if (baseline.has(schema.$id.replace(/#\/?$/, ''))) {
      throw new Error(`Schema $id ${schema.$id} is reserved`)
    }
  }

  let check: ReturnType<AjvInstance['compile']>
  try {
    check = ajv.compile(schema)
  } finally {
    // A compile must not leave anything registered, so a failed compile or a nested $id cannot
    // block a later schema. Removing by baseline, not with a no-argument removeSchema(), keeps
    // AJV's meta-schema alias.
    if (typeof schema === 'object') {
      ajv.removeSchema(schema)
    }
    const added = [...Object.keys(ajv.schemas), ...Object.keys(ajv.refs)].filter(
      (key) => !baseline.has(key),
    )
    for (const key of added) {
      ajv.removeSchema(key)
    }
  }

  return (value: unknown) => {
    return check(value) ? { value: value as T } : new ValidationError(schema, value, check.errors)
  }
}

/**
 * Validator function, returning a Result of the validation.
 */
export type Validator<T> = (value: unknown) => StandardSchemaV1.Result<T>

/**
 * Validator function factory using a JSON schema.
 */
export function createValidator<S extends Schema, T = FromSchema<S>>(
  schema: S,
  options?: ValidatorOptions,
): Validator<T> {
  const draft = options?.draft ?? '07'
  const strict = options?.strict ?? 'default'
  const cacheKey = `${draft}:${strict}`

  // Boolean schemas cannot key a WeakMap and are cheap to recompile.
  if (typeof schema !== 'object') {
    return compileValidator<T>(getAjv(draft, options?.strict), schema)
  }

  let byOptions = validators.get(schema)
  if (byOptions == null) {
    byOptions = new Map()
    validators.set(schema, byOptions)
  }
  const cached = byOptions.get(cacheKey)
  if (cached != null) {
    return cached as Validator<T>
  }

  const validator = compileValidator<T>(getAjv(draft, options?.strict), schema)
  byOptions.set(cacheKey, validator as Validator<unknown>)
  return validator
}

/**
 * Create a validator factory with its own AJV instance, shared with nothing else. Use it for
 * schemas that arrive at runtime: disposing the factory releases every compiled validator, which
 * the shared instances behind `createValidator` retain for the life of the process.
 */
export function createValidatorFactory(options?: ValidatorFactoryOptions): ValidatorFactory {
  let context: AjvContext | null = createAjv({
    draft: options?.draft ?? '07',
    strict: options?.strict,
    logger: options?.logger,
  })
  let validators = new WeakMap<Schema, Validator<unknown>>()
  let compiled = 0

  return {
    createValidator<S extends Schema, T = FromSchema<S>>(schema: S): Validator<T> {
      if (context == null) {
        throw new Error('Validator factory is disposed')
      }
      // Boolean schemas cannot key a WeakMap and are cheap to recompile.
      if (typeof schema !== 'object') {
        compiled++
        return compileValidator<T>(context, schema)
      }

      const cached = validators.get(schema)
      if (cached != null) {
        return cached as Validator<T>
      }
      const validator = compileValidator<T>(context, schema)
      compiled++
      validators.set(schema, validator as Validator<unknown>)
      return validator
    },
    get compiled() {
      return compiled
    },
    dispose() {
      context = null
      validators = new WeakMap()
    },
  }
}

/**
 * Asserts the type of the given `value` using the `validator`.
 */
export function assertType<T>(validator: Validator<T>, value: unknown): asserts value is T {
  const result = validator(value)
  if (result instanceof ValidationError) {
    throw result
  }
}

/**
 * Asserts the type of the given `value` using the `validator` and returns it.
 */
export function asType<T>(validator: Validator<T>, value: unknown): T {
  assertType(validator, value)
  return value
}

/**
 * Checks the type of the given `value` using the `validator`.
 */
export function isType<T>(validator: Validator<T>, value: unknown): value is T {
  return !(validator(value) instanceof ValidationError)
}

// Build the StandardJSONSchemaV1 companion converter for a validator's source
// schema. The validator compiled against a single dialect, so it only recovers
// that one target; any other target (including openapi-3.0) throws, per the
// companion spec's "throw if the target is not supported" contract. `input` and
// `output` are the same document because a plain validator's input type equals
// its output type.
function createJSONSchemaConverter(
  schema: Schema,
  draft: '07' | '2020-12',
): StandardJSONSchemaV1.Converter {
  const sourceTarget = draft === '2020-12' ? 'draft-2020-12' : 'draft-07'
  const convert = (options: StandardJSONSchemaV1.Options): Record<string, unknown> => {
    if (options.target !== sourceTarget) {
      throw new Error(`Unsupported JSON Schema target: ${options.target}`)
    }
    return schema as Record<string, unknown>
  }
  return { input: convert, output: convert }
}

/**
 * Turn a `Validator` function into a standard schema validator.
 */
export function toStandardValidator<T>(validator: Validator<T>): StandardSchemaV1<T>
export function toStandardValidator<T>(
  validator: Validator<T>,
  schema: Schema,
  options?: ValidatorOptions,
): StandardSchemaV1<T> & StandardJSONSchemaV1<T>
export function toStandardValidator<T>(
  validator: Validator<T>,
  schema?: Schema,
  options?: ValidatorOptions,
): StandardSchemaV1<T> {
  if (schema == null) {
    return {
      '~standard': {
        version: 1,
        vendor: 'sozai',
        validate: validator,
      },
    }
  }
  const result: StandardSchemaV1<T> & StandardJSONSchemaV1<T> = {
    '~standard': {
      version: 1,
      vendor: 'sozai',
      validate: validator,
      jsonSchema: createJSONSchemaConverter(schema, options?.draft ?? '07'),
    },
  }
  return result
}

/**
 * Create a standard schema validator.
 */
export function createStandardValidator<S extends Schema, T = FromSchema<S>>(
  schema: S,
  options?: ValidatorOptions,
): StandardSchemaV1<T> & StandardJSONSchemaV1<T> {
  return toStandardValidator(createValidator<S, T>(schema, options), schema, options)
}
