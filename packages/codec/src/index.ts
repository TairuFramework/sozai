/**
 * Sozai codecs.
 *
 * ## Installation
 *
 * ```sh
 * npm install @sozai/codec
 * ```
 *
 * @module codec
 */

import serialize from 'canonicalize'

/**
 * Serialize a value to canonical JSON, with deterministic key ordering.
 *
 * Throws a `TypeError` if the value has no JSON representation at all — `undefined`, a
 * function or a symbol. Returning a non-string here would silently encode to `""` downstream
 * in {@link b64uFromJSON}.
 *
 * Also throws (propagated from the underlying `canonicalize` call) on values a plain
 * `JSON.stringify` would reject or silently mangle: `Error('NaN is not allowed')`,
 * `Error('Infinity is not allowed')`, `Error('Circular reference detected')`, and
 * `TypeError('Do not know how to serialize a BigInt')`. These are stricter than
 * `JSON.stringify`, which turns `NaN`/`Infinity` into `null` rather than throwing — so
 * `b64uFromJSON({a: NaN})` throws while `b64uFromJSON({a: NaN}, false)` succeeds with
 * `{"a":null}`. The two modes differ on more than key order.
 *
 * Known upstream limitation: a *nested* function produces invalid JSON — a bare `undefined`
 * token in objects, an elided element in arrays — rather than having its key dropped. Nested
 * symbols and `undefined` values are handled correctly. Tracked by
 * https://github.com/erdtman/canonicalize/pull/22
 */
export function canonicalStringify(value: unknown): string {
  const serialized = serialize(value)
  if (serialized === undefined) {
    throw new TypeError('Value has no canonical JSON representation')
  }
  return serialized
}

// Adapted from https://developer.mozilla.org/en-US/docs/Glossary/Base64#the_unicode_problem

/**
 * Convert a base64-encoded string to a Uint8Array using the `atob` fallback decoder.
 *
 * @internal Performs no validation — it decodes whatever `atob` accepts, including malformed
 * shapes (e.g. embedded whitespace) that {@link fromB64} rejects. It exists as the fallback
 * decode path on runtimes without `Uint8Array.fromBase64`, and as a seam for testing that
 * path. Callers should use {@link fromB64} instead.
 */
export function fromB64atob(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (m) => m.codePointAt(0) as number)
}

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/

/**
 * Convert a base64-encoded string to a Uint8Array.
 *
 * Surrounding whitespace is tolerated and trimmed before validation — base64 commonly arrives
 * from files, environment variables, and CLI flags with a trailing newline. Embedded
 * whitespace and any character outside the standard alphabet throw
 * `Error('Invalid base64 encoding')`. A whitespace-only string is rejected too: it is distinct
 * from the empty string, which is accepted and decodes to an empty `Uint8Array`. This is the
 * mirror image of {@link fromB64U}, which does not trim.
 */
export function fromB64(base64: string): Uint8Array {
  const trimmed = base64.trim()
  if ((base64.length > 0 && trimmed.length === 0) || !B64_RE.test(trimmed)) {
    throw new Error('Invalid base64 encoding')
  }
  return typeof Uint8Array.fromBase64 === 'function'
    ? Uint8Array.fromBase64(trimmed, { alphabet: 'base64' })
    : fromB64atob(trimmed)
}

const B64U_RE = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}(?:==)?|[A-Za-z0-9_-]{3}=?)?$/

/**
 * Convert a base64url-encoded string to a Uint8Array using the `atob` fallback decoder.
 *
 * @internal Performs no validation — it decodes whatever `atob` accepts once the URL-safe
 * characters have been remapped, including malformed shapes (e.g. embedded whitespace) that
 * {@link fromB64U} rejects. It exists as the fallback decode path on runtimes without
 * `Uint8Array.fromBase64`, and as a seam for testing that path. Callers should use
 * {@link fromB64U} instead.
 */
export function fromB64Uatob(base64url: string): Uint8Array {
  return fromB64atob(base64url.replace(/-/g, '+').replace(/_/g, '/'))
}

/**
 * Convert a base64url-encoded string to a Uint8Array.
 *
 * Accepts padded input (lenient decode) — this is why tokens issued before `toB64U` started
 * emitting unpadded output still verify. Unlike {@link fromB64}, this does *not* trim
 * surrounding whitespace: its input is JWT segments off the wire, where whitespace is always
 * corruption rather than incidental formatting. Any character outside the URL-safe alphabet,
 * embedded or surrounding whitespace, or padding in an invalid position throws
 * `Error('Invalid base64url encoding')`.
 */
export function fromB64U(base64url: string): Uint8Array {
  if (!B64U_RE.test(base64url)) {
    throw new Error('Invalid base64url encoding')
  }
  return typeof Uint8Array.fromBase64 === 'function'
    ? Uint8Array.fromBase64(base64url, { alphabet: 'base64url' })
    : fromB64Uatob(base64url)
}

/**
 * Convert a Uint8Array to a base64-encoded string.
 */
export function toB64(bytes: Uint8Array): string {
  if (typeof Uint8Array.prototype.toBase64 === 'function') {
    return bytes.toBase64({ alphabet: 'base64' })
  }
  return btoa(Array.from(bytes, (byte: number) => String.fromCodePoint(byte)).join(''))
}

/**
 * Convert a Uint8Array to an unpadded base64url-encoded string.
 *
 * Output carries no `=` padding, as required by RFC 7515 (JWS) and RFC 4648 §5. Note that
 * `toB64` (standard base64) *is* padded, per RFC 4648 §4.
 */
export function toB64U(bytes: Uint8Array): string {
  if (typeof Uint8Array.prototype.toBase64 === 'function') {
    return bytes.toBase64({ alphabet: 'base64url', omitPadding: true })
  }
  return toB64(bytes)
    .replace(/=+$/, '')
    .replace(/[+/]/g, (m) => (m === '+' ? '-' : '_'))
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Convert a UTF string to a Uint8Array.
 *
 * Lone surrogates (unpaired UTF-16 code units) are replaced with U+FFFD, per the WHATWG
 * `TextEncoder` contract — `TextEncoder` has no `fatal` option, and this cannot be overridden.
 * Consequently two distinct input strings can encode to identical bytes (e.g. `'\uD800'` and
 * `'�'` both produce `[239, 191, 189]`), which the fatal {@link toUTF} decoder cannot
 * detect on the way back — unlike `toUTF`, this direction is not strict.
 */
export function fromUTF(value: string): Uint8Array {
  return encoder.encode(value)
}

/**
 * Convert a Uint8Array to a UTF string.
 *
 * Throws a `TypeError` if the bytes are not valid UTF-8. Decoding is deliberately strict:
 * this codec sits under signature verification, where silently substituting U+FFFD would let
 * corrupted bytes decode to a plausible string.
 */
export function toUTF(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/**
 * Convert a UTF string to a base64url-encoded string.
 */
export function b64uFromUTF(value: string): string {
  return toB64U(fromUTF(value))
}

/**
 * Convert a JSON object to a base64url-encoded string.
 *
 * @param canonicalize - When `true` (the default), serializes via {@link canonicalStringify}
 * (RFC 8785 deterministic key ordering), which also throws on `NaN`, `Infinity`, circular
 * references, and `BigInt` values. When `false`, serializes via plain `JSON.stringify`, which
 * instead silently converts `NaN`/`Infinity` to `null` and throws only on circular references
 * or `BigInt`. The two modes can therefore diverge on more than key order — for example,
 * `b64uFromJSON({a: NaN})` throws while `b64uFromJSON({a: NaN}, false)` succeeds and encodes
 * `{"a":null}`.
 */
export function b64uFromJSON(value: Record<string, unknown>, canonicalize = true): string {
  return b64uFromUTF(canonicalize ? canonicalStringify(value) : JSON.stringify(value))
}

/**
 * Convert a base64url-encoded string to a UTF string.
 */
export function b64uToUTF(base64url: string): string {
  return toUTF(fromB64U(base64url))
}

const MAX_JSON_DEPTH = 128

function checkJSONDepth(json: string): void {
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
      if (depth > MAX_JSON_DEPTH) {
        throw new Error(`JSON exceeds maximum nesting depth of ${MAX_JSON_DEPTH}`)
      }
    } else if (char === '}' || char === ']') {
      depth--
    }
  }
}

/**
 * Convert a base64url-encoded string to a JSON object.
 */
export function b64uToJSON<T = Record<string, unknown>>(base64url: string): T {
  const json = b64uToUTF(base64url)
  checkJSONDepth(json)
  return JSON.parse(json)
}
