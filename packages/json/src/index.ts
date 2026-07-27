/**
 * Canonical JSON serialization and hardened parsing.
 *
 * ## Installation
 *
 * ```sh
 * npm install @sozai/json
 * ```
 *
 * @module json
 */

/**
 * Serialize a value to canonical JSON, per RFC 8785 (JSON Canonicalization Scheme).
 *
 * Object keys are sorted by UTF-16 code unit (RFC 8785 section 3.2.3), and numbers and strings
 * are serialized by `JSON.stringify`, which implements exactly the format the RFC requires.
 *
 * Returns `undefined` when the value itself has no JSON representation — `undefined`, a function
 * or a symbol — mirroring `JSON.stringify`. Callers needing a guaranteed string should wrap this
 * and throw.
 *
 * Throws a `TypeError` on values that cannot be represented in canonical JSON: `NaN`, `Infinity`,
 * `BigInt`, and circular references. This is stricter than `JSON.stringify`, which turns
 * `NaN` and `Infinity` into `null`. Deeply nested values may throw a `RangeError` from stack
 * exhaustion, as `JSON.stringify` does.
 *
 * Otherwise the output matches `JSON.stringify` semantics: `toJSON` is honored, boxed primitives
 * are unwrapped, each property is read exactly once, non-serializable values are omitted from
 * objects and become `null` in arrays, and sparse array holes become `null`.
 */
export function canonicalize(value: unknown): string | undefined {
  return serialize(value, '', new Set())
}

function serialize(value: unknown, key: string, seen: Set<object>): string | undefined {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      throw new TypeError('NaN is not allowed')
    }
    if (!Number.isFinite(value)) {
      throw new TypeError('Infinity is not allowed')
    }
  }
  if (typeof value === 'bigint') {
    throw new TypeError('BigInt is not allowed')
  }

  // Covers null, numbers, strings and booleans, and returns undefined for the three
  // non-serializable types — which every caller below already handles.
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  const object = value as Record<string, unknown>
  const toJSON = object.toJSON
  if (typeof toJSON === 'function') {
    if (seen.has(object)) {
      throw new TypeError('Circular reference detected')
    }
    seen.add(object)
    const result = serialize((toJSON as (key: string) => unknown).call(object, key), key, seen)
    seen.delete(object)
    return result
  }

  if (object instanceof Number || object instanceof String || object instanceof Boolean) {
    return serialize(object.valueOf(), key, seen)
  }

  if (seen.has(object)) {
    throw new TypeError('Circular reference detected')
  }
  seen.add(object)

  let result: string
  if (Array.isArray(object)) {
    const values: Array<string> = []
    // Indexed rather than `.map`, which skips holes in a sparse array and would emit an
    // elided element instead of `null`.
    for (let index = 0; index < object.length; index++) {
      values.push(serialize(object[index], String(index), seen) ?? 'null')
    }
    result = `[${values.join(',')}]`
  } else {
    const parts: Array<string> = []
    for (const name of Object.keys(object).sort()) {
      // Read once, so getters fire once.
      const serialized = serialize(object[name], name, seen)
      // Catches a raw undefined/function/symbol and a toJSON that returned one.
      if (serialized === undefined) {
        continue
      }
      parts.push(`${JSON.stringify(name)}:${serialized}`)
    }
    result = `{${parts.join(',')}}`
  }

  seen.delete(object)
  return result
}

const DEFAULT_MAX_DEPTH = 128

/** Options for {@link parse}. */
export type ParseOptions = {
  /**
   * Maximum nesting depth accepted, checked before parsing. Defaults to 128.
   */
  maxDepth?: number
}

/**
 * Parse JSON with a nesting limit.
 *
 * The depth check runs over the raw text before `JSON.parse`, so a hostile payload never reaches
 * the parser. Exceeding the limit throws
 * `Error('JSON exceeds maximum nesting depth of N')`.
 */
export function parse<T = unknown>(json: string, options: ParseOptions = {}): T {
  const { maxDepth = DEFAULT_MAX_DEPTH } = options
  checkDepth(json, maxDepth)
  return JSON.parse(json) as T
}

function checkDepth(json: string, maxDepth: number): void {
  let depth = 0
  let inString = false
  let isEscaped = false
  for (let i = 0; i < json.length; i++) {
    const char = json[i]
    if (isEscaped) {
      isEscaped = false
      continue
    }
    if (inString) {
      if (char === '\\') isEscaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{' || char === '[') {
      depth++
      if (depth > maxDepth) {
        throw new Error(`JSON exceeds maximum nesting depth of ${maxDepth}`)
      }
    } else if (char === '}' || char === ']') {
      depth--
    }
  }
}
