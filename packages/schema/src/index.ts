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

export type { StandardSchemaV1 } from '@standard-schema/spec'
export type { FromSchema } from 'json-schema-to-ts'

export { ValidationError, ValidationErrorObject } from './errors.js'
export type { Schema } from './types.js'
export { resolveReference, resolveSchema } from './utils.js'
export {
  assertType,
  asType,
  createStandardValidator,
  createValidator,
  isType,
  toStandardValidator,
  type Validator,
  type ValidatorOptions,
} from './validation.js'
