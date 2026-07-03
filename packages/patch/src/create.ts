import type { PatchOperation } from './schemas.js'

function escapeKey(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1')
}

function sameValueZero(a: unknown, b: unknown): boolean {
  return a === b || Object.is(a, b)
}

/**
 * Creates JSON Patch operations to transform one object into another.
 *
 * Generates the minimal set of operations needed to transform the `from`
 * object into the `to` object. The resulting patches can be applied
 * using `applyPatches`.
 *
 * @param to - Target object state
 * @param from - Source object state (defaults to empty object). NOTE: `to` comes first
 *   (reversed from typical diff APIs) so `from` can be optional — `createPatches(to)`
 *   diffs against an empty object.
 * @returns Array of patch operations
 *
 * @example
 * ```typescript
 * const from = { foo: 1, bar: 'old' }
 * const to = { foo: 2, baz: 'new' }
 * const patches = createPatches(to, from)
 * // Returns:
 * // [
 * //   { op: 'replace', path: '/foo', value: 2 },
 * //   { op: 'remove', path: '/bar' },
 * //   { op: 'add', path: '/baz', value: 'new' }
 * // ]
 * ```
 *
 * @public
 */
export function createPatches(
  to: Record<string, unknown>,
  from: Record<string, unknown> = {},
): Array<PatchOperation> {
  const patches: Array<PatchOperation> = []

  // Helper function to recursively compare objects and generate patches
  function compareObjects(
    toObj: Record<string, unknown>,
    fromObj: Record<string, unknown>,
    path: string,
  ): void {
    // Process keys in order: first from 'from' object, then any additional from 'to' object
    const fromKeys = Object.keys(fromObj)
    const toKeys = Object.keys(toObj)
    const additionalKeys = toKeys.filter((key) => !fromKeys.includes(key))

    // Process existing keys first (in their original order)
    for (const key of fromKeys) {
      const toValue = toObj[key]
      const fromValue = fromObj[key]

      // If key doesn't exist in 'to' (or its value is undefined), it's a remove operation
      if (!(key in toObj) || toObj[key] === undefined) {
        patches.push({ op: 'remove', path: `${path}/${escapeKey(key)}` })
        continue
      }

      const currentPath = `${path}/${escapeKey(key)}`

      // If values are different, handle based on their types
      if (!sameValueZero(toValue, fromValue)) {
        if (toValue === null) {
          // Replace with null
          patches.push({ op: 'replace', path: currentPath, value: null })
        } else if (fromValue === null) {
          // Replace null with new value
          patches.push({ op: 'replace', path: currentPath, value: toValue })
        } else if (Array.isArray(toValue) !== Array.isArray(fromValue)) {
          // Type changed between array and object (or other type): emit a single replace
          patches.push({ op: 'replace', path: currentPath, value: toValue })
        } else if (Array.isArray(toValue) && Array.isArray(fromValue)) {
          // Handle arrays
          compareArrays(toValue, fromValue, currentPath)
        } else if (
          typeof toValue === 'object' &&
          toValue !== null &&
          typeof fromValue === 'object' &&
          fromValue !== null
        ) {
          // Recursively compare nested objects
          compareObjects(
            toValue as Record<string, unknown>,
            fromValue as Record<string, unknown>,
            currentPath,
          )
        } else {
          // Replace primitive values
          patches.push({ op: 'replace', path: currentPath, value: toValue })
        }
      }
    }

    // Process additional keys (new keys in 'to' object)
    for (const key of additionalKeys) {
      const toValue = toObj[key]
      if (toValue === undefined) {
        continue
      }
      const currentPath = `${path}/${escapeKey(key)}`
      patches.push({ op: 'add', path: currentPath, value: toValue })
    }
  }

  // Helper function to compare arrays
  function compareArrays(toArr: Array<unknown>, fromArr: Array<unknown>, path: string): void {
    // Handle adds and replaces first
    const minLength = Math.min(toArr.length, fromArr.length)

    for (let i = 0; i < minLength; i++) {
      const currentPath = `${path}/${i}`
      const toValue = toArr[i]
      const fromValue = fromArr[i]

      // If values are different, handle based on their types
      if (!sameValueZero(toValue, fromValue)) {
        if (toValue === null) {
          patches.push({ op: 'replace', path: currentPath, value: null })
        } else if (fromValue === null) {
          patches.push({ op: 'replace', path: currentPath, value: toValue })
        } else if (Array.isArray(toValue) !== Array.isArray(fromValue)) {
          // Type changed between array and object (or other type): emit a single replace
          patches.push({ op: 'replace', path: currentPath, value: toValue })
        } else if (Array.isArray(toValue) && Array.isArray(fromValue)) {
          // Recursively compare nested arrays
          compareArrays(toValue, fromValue, currentPath)
        } else if (
          typeof toValue === 'object' &&
          toValue !== null &&
          typeof fromValue === 'object' &&
          fromValue !== null
        ) {
          // Recursively compare nested objects
          compareObjects(
            toValue as Record<string, unknown>,
            fromValue as Record<string, unknown>,
            currentPath,
          )
        } else {
          // Replace primitive values
          patches.push({ op: 'replace', path: currentPath, value: toValue })
        }
      }
    }

    // Handle adds (elements that exist in 'to' but not in 'from')
    for (let i = fromArr.length; i < toArr.length; i++) {
      const currentPath = `${path}/${i}`
      patches.push({ op: 'add', path: currentPath, value: toArr[i] })
    }

    // Handle removes (elements that exist in 'from' but not in 'to')
    // Remove from the beginning to maintain consistent indices
    for (let i = toArr.length; i < fromArr.length; i++) {
      const currentPath = `${path}/${toArr.length}`
      patches.push({ op: 'remove', path: currentPath })
    }
  }

  // Start the comparison from the root
  compareObjects(to, from, '')

  return patches
}
