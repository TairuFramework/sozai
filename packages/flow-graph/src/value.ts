import type { JSONValue } from '@sozai/json'

export const UNSAFE_PATH_SEGMENTS = ['__proto__', 'constructor', 'prototype'] as const
export const isSafePathSegment = (key: string): boolean =>
  !UNSAFE_PATH_SEGMENTS.includes(key as never)
export type Path = Array<string>
export type Value =
  | { ref: Path }
  | { value: JSONValue }
  | { object: Record<string, Value> }
  | { array: Array<Value> }
export type Scope = {
  input: JSONValue
  state: Record<string, JSONValue>
  results: Record<string, JSONValue>
  loops: Record<string, number>
}

export function readPath(path: Path, scope: Scope): JSONValue {
  try {
    if (path.length === 0 || path.some((part) => !isSafePathSegment(part))) return null
    let value: unknown = (scope as unknown as Record<string, unknown>)[path[0] as string]
    for (const part of path.slice(1)) {
      if (value == null || typeof value !== 'object' || !Object.hasOwn(value, part)) return null
      value = (value as Record<string, unknown>)[part]
    }
    return value === undefined ? null : (value as JSONValue)
  } catch {
    return null
  }
}

export function resolveValue(value: Value, scope: Scope): JSONValue {
  if ('ref' in value) return readPath(value.ref, scope)
  if ('value' in value) return value.value
  if ('array' in value) return value.array.map((item) => resolveValue(item, scope))
  return Object.fromEntries(
    Object.entries(value.object).map(([key, item]) => [key, resolveValue(item, scope)]),
  )
}

export function writeState(state: Record<string, JSONValue>, path: Path, value: JSONValue): void {
  if (path[0] !== 'state' || path.length < 2 || path.some((key) => !isSafePathSegment(key)))
    throw new TypeError('Invalid state path')
  let target: Record<string, JSONValue> = state
  for (const part of path.slice(1, -1)) {
    const existing = target[part as string]
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing))
      target[part as string] = {}
    target = target[part as string] as Record<string, JSONValue>
  }
  target[path[path.length - 1] as string] = value
}
