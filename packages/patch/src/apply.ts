import type { PatchOperation } from './schemas.js'

/**
 * Error thrown when patch operations fail.
 *
 * @public
 */
export class PatchError extends Error {
  code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'PatchError'
    this.code = code
  }
}

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])
const ARRAY_INDEX_RE = /^(0|[1-9]\d*)$/

function sameValueZero(a: unknown, b: unknown): boolean {
  // biome-ignore lint/suspicious/noSelfCompare: NaN check for SameValueZero semantics
  return a === b || (a !== a && b !== b)
}

/**
 * Deep structural equality with SameValueZero leaves (`NaN` equals `NaN`; `+0` equals `-0`).
 *
 * @public
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (sameValueZero(a, b)) {
    return true
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  const aArray = Array.isArray(a)
  if (aArray !== Array.isArray(b)) {
    return false
  }
  if (aArray) {
    const aArr = a as Array<unknown>
    const bArr = b as Array<unknown>
    return aArr.length === bArr.length && aArr.every((v, i) => deepEqual(v, bArr[i]))
  }
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  return (
    aKeys.length === Object.keys(bObj).length &&
    aKeys.every((k) => Object.hasOwn(bObj, k) && deepEqual(aObj[k], bObj[k]))
  )
}

function assertValidPath(path: string): void {
  if (!path.startsWith('/')) {
    throw new PatchError('Path must start with /', 'INVALID_PATH')
  }
}

function assertPathExists(obj: unknown, path: string): void {
  const value = getPath(obj, path)
  if (value === undefined) {
    throw new PatchError(`Path ${path} does not exist`, 'PATH_NOT_FOUND')
  }
}

/**
 * Parses a JSON Pointer path into an array of keys.
 *
 * @param path - JSON Pointer path (e.g., "/foo/bar/0")
 * @returns Array of property keys and array indices
 * @throws {PatchError} When path doesn't start with '/'
 *
 * @public
 */
export function parsePath(path: string): Array<string | number> {
  assertValidPath(path)
  return path
    .slice(1)
    .split('/')
    .map((key) => {
      // Handle JSON Pointer escape sequences
      const unescaped = key.replace(/~1/g, '/').replace(/~0/g, '~')
      if (FORBIDDEN_SEGMENTS.has(unescaped)) {
        throw new PatchError(`Forbidden path segment: ${unescaped}`, 'INVALID_PATH')
      }
      // Convert canonical array indices to numbers; keep everything else (including
      // the empty string and the '-' append sentinel) as a string key.
      if (unescaped === '' || unescaped === '-') {
        return unescaped
      }
      return ARRAY_INDEX_RE.test(unescaped) ? Number(unescaped) : unescaped
    })
}

/**
 * Gets a value from an object using a JSON Pointer path.
 *
 * @param obj - Object to traverse
 * @param path - JSON Pointer path
 * @returns The value at the specified path, or undefined if not found
 *
 * @public
 */
export function getPath(obj: unknown, path: string): unknown {
  const keys = parsePath(path)
  // @ts-expect-error index signature
  return keys.reduce((acc, key) => acc?.[key], obj)
}

/**
 * Sets a value in an object using a JSON Pointer path.
 *
 * @param obj - Object to modify
 * @param path - JSON Pointer path
 * @param value - Value to set
 * @param opts - Options controlling existence checks and array insert semantics
 * @throws {PatchError} When path validation fails
 *
 * @public
 */
export function setPath(
  obj: Record<string, unknown> | Array<unknown>,
  path: string,
  value: unknown,
  opts: { shouldExist?: boolean; insert?: boolean; allowAppend?: boolean } = {},
): void {
  const { shouldExist = false, insert = false, allowAppend = true } = opts
  const keys = parsePath(path)
  const lastKey = keys.pop()
  if (lastKey === undefined) {
    return
  }
  const target = keys.reduce((acc, key) => {
    if (acc === undefined) {
      throw new PatchError(`Path ${path} does not exist`, 'PATH_NOT_FOUND')
    }
    // @ts-expect-error unknown object
    return acc[key]
  }, obj)

  if (target === undefined) {
    throw new PatchError(`Path ${path} does not exist`, 'PATH_NOT_FOUND')
  }

  if (Array.isArray(target)) {
    if (lastKey === '-') {
      if (!allowAppend) {
        throw new PatchError('Append token not allowed here', 'INVALID_INDEX')
      }
      target.push(value)
      return
    }
    if (typeof lastKey !== 'number') {
      throw new PatchError('Array index must be a number', 'INVALID_INDEX')
    }
    const max = allowAppend ? target.length : target.length - 1
    if (lastKey < 0 || lastKey > max) {
      throw new PatchError(
        `Array index ${lastKey} out of bounds (length: ${target.length})`,
        'INVALID_INDEX',
      )
    }
    if (insert) {
      target.splice(lastKey, 0, value)
    } else if (lastKey === target.length) {
      target.push(value)
    } else {
      target[lastKey] = value
    }
  } else {
    if (shouldExist && !Object.hasOwn(target as object, lastKey as string)) {
      throw new PatchError(`Path ${path} does not exist`, 'PATH_NOT_FOUND')
    }
    const targetObj = target as Record<string, unknown>
    targetObj[lastKey as string] = value
  }
}

/**
 * Deletes a value from an object using a JSON Pointer path.
 *
 * @param obj - Object to modify
 * @param path - JSON Pointer path
 * @throws {PatchError} When path doesn't exist or is invalid
 *
 * @public
 */
export function deletePath(
  obj: Record<string, unknown> | Array<unknown>,
  path: string,
  strict = true,
): void {
  const keys = parsePath(path)
  const lastKey = keys.pop()
  if (lastKey !== undefined) {
    const target = keys.reduce((acc, key) => {
      if (acc === undefined && strict) {
        throw new PatchError(`Path ${path} does not exist`, 'PATH_NOT_FOUND')
      }
      // @ts-expect-error unknown object
      return acc[key]
    }, obj)

    if (target === undefined && strict) {
      throw new PatchError(`Path ${path} does not exist`, 'PATH_NOT_FOUND')
    }

    if (Array.isArray(target)) {
      if (typeof lastKey !== 'number') {
        throw new PatchError('Array index must be a number', 'INVALID_INDEX')
      }
      if (lastKey < 0 || lastKey >= target.length) {
        throw new PatchError(
          `Array index ${lastKey} out of bounds (length: ${target.length})`,
          'INVALID_INDEX',
        )
      }
      target.splice(lastKey, 1)
    } else {
      if (!Object.hasOwn(target as object, lastKey as string) && strict) {
        throw new PatchError(`Path ${path} does not exist`, 'PATH_NOT_FOUND')
      }
      const targetObj = target as Record<string, unknown>
      delete targetObj[lastKey as string]
    }
  }
}

/**
 * Applies an array of JSON Patch operations to an object.
 *
 * Operations are applied sequentially. If any operation fails,
 * the function throws and no further operations are applied.
 *
 * @param data - Object to modify
 * @param patches - Array of patch operations to apply
 * @param strict - Whether to throw on non-existent paths (default: true)
 * @throws {PatchError} When any operation fails
 *
 * @example
 * ```typescript
 * const data = { foo: { bar: 1 } }
 * applyPatches(data, [
 *   { op: 'replace', path: '/foo/bar', value: 2 },
 *   { op: 'add', path: '/foo/baz', value: 3 }
 * ])
 * // data is now { foo: { bar: 2, baz: 3 } }
 * ```
 *
 * @public
 */
export function applyPatches(
  data: Record<string, unknown>,
  patches: Array<PatchOperation>,
  strict = true,
): void {
  for (const patch of patches) {
    switch (patch.op) {
      case 'add':
        setPath(data, patch.path, patch.value, { insert: true, allowAppend: true })
        break
      case 'replace':
        if (strict) {
          assertPathExists(data, patch.path)
        }
        setPath(data, patch.path, patch.value, { shouldExist: strict, allowAppend: false })
        break
      case 'set':
        setPath(data, patch.path, patch.value, { allowAppend: true })
        break
      case 'remove':
        if (strict) {
          assertPathExists(data, patch.path)
        }
        deletePath(data, patch.path)
        break
      case 'copy': {
        assertPathExists(data, patch.from)
        const value = getPath(data, patch.from)
        if (value === undefined) {
          throw new PatchError(`Source path ${patch.from} does not exist`, 'PATH_NOT_FOUND')
        }
        setPath(data, patch.path, value)
        break
      }
      case 'move': {
        assertPathExists(data, patch.from)
        const value = getPath(data, patch.from)
        if (value === undefined) {
          throw new PatchError(`Source path ${patch.from} does not exist`, 'PATH_NOT_FOUND')
        }
        deletePath(data, patch.from)
        setPath(data, patch.path, value)
        break
      }
      case 'test': {
        assertPathExists(data, patch.path)
        const value = getPath(data, patch.path)
        if (!deepEqual(value, patch.value)) {
          throw new PatchError(
            `Test operation failed at path ${patch.path}: expected ${JSON.stringify(patch.value)}, got ${JSON.stringify(value)}`,
            'TEST_FAILED',
          )
        }
        break
      }
      default:
        // @ts-expect-error never type
        throw new PatchError(`Unknown operation: ${patch.op}`, 'INVALID_OPERATION')
    }
  }
}
