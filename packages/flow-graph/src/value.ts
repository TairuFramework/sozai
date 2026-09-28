import type { JSONValue } from '@sozai/json'

/** Property names that can traverse prototype-sensitive paths. */
export const UNSAFE_PATH_SEGMENTS = ['__proto__', 'constructor', 'prototype'] as const

/** Reject prototype-sensitive path segments. */
export const isSafePathSegment = (key: string): boolean =>
  !UNSAFE_PATH_SEGMENTS.includes(key as never)

/** Segments of a scoped JSON path. */
export type Path = Array<string>

/** Literal, reference, array, or object expression. */
export type Value =
  | { ref: Path }
  | { value: JSONValue }
  | { object: Record<string, Value> }
  | { array: Array<Value> }

/** Values visible to node expressions. */
export type Scope = {
  input: JSONValue
  state: Record<string, JSONValue>
  results: Record<string, JSONValue>
  loops: Record<string, number>
}

/** Resolve a scoped path, returning null when it is unavailable. */
export function readPath(path: Path, scope: Scope): JSONValue {
  try {
    if (path.length === 0 || path.some((part) => !isSafePathSegment(part))) {
      return null
    }

    if (!Object.hasOwn(scope, path[0] as string)) {
      return null
    }

    let value: unknown = (scope as unknown as Record<string, unknown>)[path[0] as string]

    for (const part of path.slice(1)) {
      if (value == null || typeof value !== 'object' || !Object.hasOwn(value, part)) {
        return null
      }

      value = (value as Record<string, unknown>)[part]
    }

    return value === undefined ? null : (value as JSONValue)
  } catch {
    return null
  }
}

/** Resolve a value expression into independent JSON data. */
export function resolveValue(value: Value, scope: Scope): JSONValue {
  if ('ref' in value) {
    return structuredClone(readPath(value.ref, scope))
  }

  if ('value' in value) {
    return structuredClone(value.value)
  }

  if ('array' in value) {
    return value.array.map((item) => resolveValue(item, scope))
  }

  return Object.fromEntries(
    Object.entries(value.object).map(([key, item]) => [key, resolveValue(item, scope)]),
  )
}

/** Assign a resolved value beneath the state root. */
export function writeState(state: Record<string, JSONValue>, path: Path, value: JSONValue): void {
  if (path[0] !== 'state' || path.length < 2 || path.some((key) => !isSafePathSegment(key))) {
    throw new TypeError('Invalid state path')
  }

  let target: Record<string, JSONValue> = state

  for (const part of path.slice(1, -1)) {
    const existing = Object.hasOwn(target, part as string) ? target[part as string] : undefined

    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      target[part as string] = {}
    }

    target = target[part as string] as Record<string, JSONValue>
  }

  target[path[path.length - 1] as string] = value
}
