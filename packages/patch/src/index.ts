/**
 * JSON patch utilities.
 *
 * ## Installation
 *
 * ```sh
 * pnpm add @sozai/patch
 * ```
 *
 * @module patch
 */

export { applyPatches, PatchError } from './apply.js'
export { createPatches } from './create.js'
export * from './schemas.js'
