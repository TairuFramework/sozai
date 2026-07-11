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
 * Convert a base64-encoded string to a Uint8Array.
 */
export function fromB64atob(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (m) => m.codePointAt(0) as number)
}

export function fromB64(base64: string): Uint8Array {
  return typeof Uint8Array.fromBase64 === 'function'
    ? Uint8Array.fromBase64(base64, { alphabet: 'base64' })
    : fromB64atob(base64)
}

const B64U_RE = /^[A-Za-z0-9_-]*={0,2}$/

/**
 * Convert a base64url-encoded string to a Uint8Array.
 */
export function fromB64Uatob(base64url: string): Uint8Array {
  return fromB64atob(base64url.replace(/-/g, '+').replace(/_/g, '/'))
}

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
  if ('toBase64' in bytes) {
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
const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * Convert a UTF string to a Uint8Array.
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
