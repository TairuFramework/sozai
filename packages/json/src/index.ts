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
 * On these specific points it follows `JSON.stringify`: `toJSON` is honored and receives the
 * property key, boxed `Number`/`String`/`Boolean` objects are unwrapped, each property is read
 * exactly once, values with no JSON representation are omitted from objects and become `null` in
 * arrays, and sparse array holes become `null`. It is not a general drop-in for `JSON.stringify`
 * beyond those points — the strictness above aside, a `toJSON` returning its own receiver is
 * reported as a circular reference rather than serialized as `{}`, a boxed `BigInt`
 * (`Object(1n)`) serializes as `{}` rather than throwing, and a boxed `NaN`/`Infinity` throws
 * rather than becoming `null`.
 */
export function canonicalize(value: unknown): string | undefined {
  return encodeMember(value, '', new Set())
}

/**
 * References enclosing the value being encoded. Membership means the value is its own ancestor,
 * which is the only cycle canonical JSON cannot represent — a value repeated across siblings is
 * fine.
 *
 * A `Set` rather than a stack: the encoder only ever asks whether a reference is enclosing, never
 * which one or how deep, and a linear scan per visited node would make canonicalization quadratic
 * in nesting depth. A reference cannot be added twice, since the second attempt is a cycle and
 * throws before it gets there.
 */
type Ancestors = Set<object>

/**
 * Encode one member of the value tree: the root, an array element or an object property value.
 * `key` is the name this member is reached by, which `toJSON` receives; it is `''` at the root.
 *
 * Returns `undefined` for a member with no JSON representation, which each caller resolves in its
 * own way.
 */
function encodeMember(member: unknown, key: string, ancestors: Ancestors): string | undefined {
  return typeof member === 'object' && member !== null
    ? encodeReference(member, key, ancestors)
    : encodeScalar(member)
}

/** Encode any non-`object` value, plus `null`. */
function encodeScalar(scalar: unknown): string | undefined {
  switch (typeof scalar) {
    case 'number':
      return encodeNumber(scalar)
    case 'bigint':
      // RFC 8785 has no integer type beyond the JSON number, whose range this exceeds.
      throw new TypeError('BigInt is not allowed')
    default:
      // Strings (RFC 8785 section 3.2.1), booleans and null serialize as themselves; undefined,
      // functions and symbols yield undefined, both exactly as JSON.stringify does.
      return JSON.stringify(scalar)
  }
}

/** Encode a number per RFC 8785 section 3.2.2, rejecting the values section 3.2.2.2 excludes. */
function encodeNumber(number: number): string {
  if (Number.isNaN(number)) {
    throw new TypeError('NaN is not allowed')
  }
  if (!Number.isFinite(number)) {
    throw new TypeError('Infinity is not allowed')
  }
  // JSON.stringify formats numbers by the ECMAScript Number::toString algorithm, which is the
  // format the RFC mandates — so there is nothing to reimplement here.
  return JSON.stringify(number) as string
}

/** Encode an object reference, keeping it on the ancestor stack for the duration. */
function encodeReference(reference: object, key: string, ancestors: Ancestors): string | undefined {
  if (ancestors.has(reference)) {
    throw new TypeError('Circular reference detected')
  }
  ancestors.add(reference)
  try {
    return encodeReferenceBody(reference, key, ancestors)
  } finally {
    ancestors.delete(reference)
  }
}

/** Dispatch an object reference to its representation: custom, boxed primitive, array or object. */
function encodeReferenceBody(
  reference: object,
  key: string,
  ancestors: Ancestors,
): string | undefined {
  const toJSON = (reference as { toJSON?: unknown }).toJSON
  if (typeof toJSON === 'function') {
    const replacement = (toJSON as (key: string) => unknown).call(reference, key)
    return encodeMember(replacement, key, ancestors)
  }
  if (reference instanceof Boolean || reference instanceof Number || reference instanceof String) {
    return encodeScalar(reference.valueOf())
  }
  return Array.isArray(reference)
    ? encodeArray(reference, ancestors)
    : encodeObject(reference as Record<string, unknown>, ancestors)
}

/** Encode an array, preserving element order — the RFC only reorders object keys. */
function encodeArray(array: Array<unknown>, ancestors: Ancestors): string {
  const elements: Array<string> = []
  // Walked by index rather than mapped: Array.prototype.map skips the holes of a sparse array,
  // which would elide those elements entirely and emit invalid JSON.
  for (let index = 0; index < array.length; index++) {
    // An element with no JSON representation — a hole, undefined, a function, a symbol, or a
    // toJSON returning one of those — becomes null, since an array cannot drop a position.
    elements.push(encodeMember(array[index], String(index), ancestors) ?? 'null')
  }
  return `[${elements.join(',')}]`
}

/** Encode a plain object with its keys ordered per RFC 8785 section 3.2.3. */
function encodeObject(object: Record<string, unknown>, ancestors: Ancestors): string {
  // The default comparator of Array.prototype.sort orders by UTF-16 code unit, which is exactly
  // what the RFC asks for — note it places a surrogate pair (U+1F602, leading unit 0xD83D) before
  // U+FB33, where code-point order would not.
  const keys = Object.keys(object).sort()
  const members: Array<string> = []
  for (const key of keys) {
    // Read once and reused below, so a getter fires exactly once.
    const encoded = encodeMember(object[key], key, ancestors)
    // A property with no JSON representation is dropped rather than nulled.
    if (encoded !== undefined) {
      members.push(`${JSON.stringify(key)}:${encoded}`)
    }
  }
  return `{${members.join(',')}}`
}

const DEFAULT_MAX_DEPTH = 128

const PROTO_KEYS = new Set(['__proto__', 'constructor'])

/** How {@link parse} treats prototype-polluting keys. */
export type ProtoKeysMode = 'allow' | 'strip' | 'reject'

/** Options for {@link parse}. */
export type ParseOptions = {
  /**
   * Maximum nesting depth accepted, checked before parsing. Defaults to 128, which is also used
   * when the value is not finite — so `NaN` or `Infinity` cannot silently disable the guard. A
   * finite non-integer is floored rather than falling back to the default, so it fails closed.
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
   * `'strip'` removes the key, `'reject'` throws `TypeError('Forbidden key: <key>')` — a
   * `TypeError` so a rejected hostile payload is distinguishable from malformed JSON without
   * matching on the message. The default is `'allow'` because `{"constructor": "ACME Corp"}` is
   * legitimate data — turn the guard on where the parsed value is merged into another object.
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
  const { maxDepth, protoKeys = 'allow' } = options
  // Anything non-finite falls back to the default: `depth > NaN` is always false, so an
  // accidental NaN would otherwise turn the guard off entirely, and `Infinity` is caught by the
  // same check. A finite non-integer is floored rather than falling back, so it fails closed
  // instead of loosening to the default; a negative limit is a valid integer and keeps rejecting
  // everything, which also fails closed.
  checkDepth(json, Number.isFinite(maxDepth) ? Math.floor(maxDepth as number) : DEFAULT_MAX_DEPTH)
  if (protoKeys === 'allow') {
    return JSON.parse(json) as T
  }
  return JSON.parse(json, (key, value) => {
    if (PROTO_KEYS.has(key)) {
      if (protoKeys === 'reject') {
        throw new TypeError(`Forbidden key: ${key}`)
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
