/**
 * JSON schema validation for Sozai RPC.
 *
 * ## Installation
 *
 * ```sh
 * npm install @sozai/schema
 * ```
 *
 * @module schema
 */

export type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
export type { FromSchema } from 'json-schema-to-ts'

export {
  createValidatorCache,
  type ValidatorCache,
  type ValidatorCacheOptions,
  type ValidatorCacheStats,
} from './cache.js'
export { ValidationError, ValidationErrorObject } from './errors.js'
export type { Schema } from './types.js'
export { rebaseDefinitionReferences, resolveReference, resolveSchema } from './utils.js'
export {
  assertType,
  asType,
  createStandardValidator,
  createValidator,
  createValidatorFactory,
  isType,
  toStandardValidator,
  type Validator,
  type ValidatorFactory,
  type ValidatorFactoryOptions,
  type ValidatorLogger,
  type ValidatorOptions,
} from './validation.js'
