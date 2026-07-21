import type { Schema } from './types.js'

/**
 * Decode a single JSON Pointer reference token (RFC 6901): `~1` -> `/`, `~0` -> `~`.
 * `~1` must be replaced before `~0`.
 */
export function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

export function resolveReference(root: Schema, ref: string): Schema {
  if (!ref.startsWith('#')) {
    throw new Error(`Invalid reference format: ${ref}`)
  }

  const segments = ref.split('/').slice(1)
  let current: unknown = root
  for (const segment of segments) {
    let key: string
    try {
      key = unescapePointer(decodeURIComponent(segment))
    } catch (cause) {
      // A malformed percent-escape (e.g. a lone `%`) makes decodeURIComponent
      // throw a raw URIError; surface the traversal's own error shape instead.
      throw new Error(`Invalid reference segment: ${segment}`, { cause })
    }
    if (current == null || typeof current !== 'object') {
      throw new Error(`Invalid reference path: ${ref}`)
    }
    if (!Object.hasOwn(current, key)) {
      throw new Error(`Invalid reference segment: ${key}`)
    }
    current = (current as Record<string, unknown>)[key]
    if (current == null) {
      throw new Error(`Reference not found: ${ref}`)
    }
  }
  return current as Schema
}

export function resolveSchema(root: Schema, schema: Schema): Schema {
  const ref = schema.$ref
  return ref ? resolveReference(root, ref) : schema
}
