import { canonicalizeJSON, type JSONValue } from '@sozai/json'
import type { FromSchema } from 'json-schema-to-ts'

import type { Schema } from './types.js'
import {
  createValidatorFactory,
  type Validator,
  type ValidatorFactory,
  type ValidatorFactoryOptions,
} from './validation.js'

const DEFAULT_MAX_COMPILES = 256
const DEFAULT_MAX_ENTRIES = 64

/**
 * Options for creating a validator cache.
 */
export type ValidatorCacheOptions = {
  /** Options for each factory the cache creates. Default factory options if omitted. */
  factory?: ValidatorFactoryOptions
  /** Distinct compiles on one factory before it is disposed and replaced. Default 256. */
  maxCompiles?: number
  /** Validators (and cached compile errors) kept, least recently used evicted first. Default 64. */
  maxEntries?: number
}

/**
 * Counters describing the state of a validator cache.
 */
export type ValidatorCacheStats = {
  /** Number of times the factory was replaced since creation or the last `clear()`. */
  generation: number
  /** Compiles on the current factory, failed compiles included. */
  compiles: number
  /** Entries currently in the LRU. */
  entries: number
}

/**
 * Bounded cache of validators for schemas that arrive at runtime.
 */
export type ValidatorCache = {
  /**
   * Get the validator for a schema, compiling it on a miss. Schemas that are equal up to object
   * key order share one validator. A failed compile is cached and rethrown on later calls.
   */
  get: <TSchema extends Schema, TValue = FromSchema<TSchema>>(schema: TSchema) => Validator<TValue>
  /** Current counters. */
  stats: () => ValidatorCacheStats
  /** Dispose the current factory and drop every entry. The cache stays usable. Idempotent. */
  clear: () => void
  /** Clear the cache and make later `get` calls throw. Idempotent. */
  dispose: () => void
  /** `true` once `dispose()` has been called. */
  readonly disposed: boolean
}

function assertBound(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be an integer of at least 1, got ${value}`)
  }
}

/**
 * Create a validator cache: a least recently used map of validators over isolated factories that
 * are disposed and replaced after `maxCompiles` distinct compiles, so memory stays bounded for
 * schemas that arrive at runtime.
 *
 * Schemas must be self-contained and plain JSON. A validator checks a snapshot of the schema, so
 * `ValidationError.schema` is that snapshot and issues follow sorted key order. Look a validator
 * up at the moment of use and do not hold it longer than needed: a long-lived holder keeps its
 * disposed AJV instance alive.
 */
export function createValidatorCache(options: ValidatorCacheOptions = {}): ValidatorCache {
  const maxCompiles = options.maxCompiles ?? DEFAULT_MAX_COMPILES
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  assertBound('maxCompiles', maxCompiles)
  assertBound('maxEntries', maxEntries)

  let factory: ValidatorFactory | undefined
  let generation = 0
  let compiles = 0
  let disposed = false
  // A Map keeps insertion order: a hit re-inserts its key, eviction removes the first key.
  const entries = new Map<string, Validator<unknown> | Error>()

  function reset(): void {
    factory?.dispose()
    factory = undefined
    entries.clear()
    compiles = 0
  }

  function unwrap<TValue>(entry: Validator<unknown> | Error): Validator<TValue> {
    if (entry instanceof Error) {
      throw entry
    }
    return entry as Validator<TValue>
  }

  return {
    get<TSchema extends Schema, TValue = FromSchema<TSchema>>(schema: TSchema): Validator<TValue> {
      if (disposed) {
        throw new Error('Validator cache is disposed')
      }

      const key = canonicalizeJSON(schema as unknown as JSONValue)
      const hit = entries.get(key)
      if (hit != null) {
        entries.delete(key)
        entries.set(key, hit)
        return unwrap<TValue>(hit)
      }

      if (factory != null && compiles >= maxCompiles) {
        reset()
        generation++
      }
      if (factory == null) {
        factory = createValidatorFactory(options.factory)
      }

      let entry: Validator<unknown> | Error
      try {
        // Compile a snapshot, never the caller's object, so the validator matches its key.
        entry = factory.createValidator(JSON.parse(key) as Schema) as Validator<unknown>
      } catch (error) {
        entry = error instanceof Error ? error : new Error(String(error))
      } finally {
        compiles++
      }

      entries.set(key, entry)
      if (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value as string)
      }
      return unwrap<TValue>(entry)
    },

    stats() {
      return { generation, compiles, entries: entries.size }
    },

    clear() {
      reset()
      generation = 0
    },

    dispose() {
      reset()
      generation = 0
      disposed = true
    },

    get disposed() {
      return disposed
    },
  }
}
