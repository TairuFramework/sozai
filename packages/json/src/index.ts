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

const PROTO_KEYS = new Set(['__proto__', 'constructor'])

/** How {@link parse} treats prototype-polluting keys. */
export type ProtoKeysMode = 'allow' | 'strip' | 'reject'

/** Options for {@link parse}. */
export type ParseOptions = {
  /**
   * Maximum nesting depth accepted, checked before parsing. Defaults to 128.
   */
  maxDepth?: number
  /**
   * How to treat the `__proto__` and `constructor` keys. Defaults to `'allow'`.
   *
   * `JSON.parse` does not pollute prototypes on its own — it creates an ordinary own property
   * and leaves the prototype untouched. The payload is inert until a consumer merges it, and the
   * two guarded keys cover the two distinct merge paths: `__proto__` is reached by any
   * `[[Set]]`-based copy (`Object.assign`, `target[key] = value`), which triggers the inherited
   * `__proto__` setter; `constructor` is the deep-merge path, where walking
   * `target.constructor.prototype` reaches `Object.prototype` and is the published bypass of
   * `__proto__`-only blocklists.
   *
   * `'strip'` removes the key, `'reject'` throws `Error('Forbidden key: <key>')`. The default is
   * `'allow'` because `{"constructor": "ACME Corp"}` is legitimate data — turn the guard on where
   * the parsed value is merged into another object.
   *
   * `prototype` is deliberately not guarded: on a plain-object merge target it is `undefined`,
   * and it is unreachable without first traversing `constructor`.
   */
  protoKeys?: ProtoKeysMode
}

/**
 * Parse JSON with a nesting limit and an optional prototype-key guard.
 *
 * The depth check runs over the raw text before `JSON.parse`, so a hostile payload never reaches
 * the parser. Exceeding the limit throws
 * `Error('JSON exceeds maximum nesting depth of N')`.
 *
 * See {@link ParseOptions.protoKeys} for the prototype-key guard, which is off by default.
 */
export function parse<T = unknown>(json: string, options: ParseOptions = {}): T {
  const { maxDepth = DEFAULT_MAX_DEPTH, protoKeys = 'allow' } = options
  checkDepth(json, maxDepth)
  if (protoKeys === 'allow') {
    return JSON.parse(json) as T
  }
  return JSON.parse(json, (key, value) => {
    if (PROTO_KEYS.has(key)) {
      if (protoKeys === 'reject') {
        throw new Error(`Forbidden key: ${key}`)
      }
      // Returning undefined from a reviver deletes the property.
      return undefined
    }
    return value
  }) as T
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
