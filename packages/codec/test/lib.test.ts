import { equals } from 'uint8arrays'
import { describe, expect, test } from 'vitest'

import {
  b64uFromJSON,
  b64uFromUTF,
  b64uToJSON,
  b64uToUTF,
  canonicalStringify,
  fromB64,
  fromB64atob,
  fromB64U,
  fromB64Uatob,
  fromUTF,
  toB64,
  toB64U,
  toUTF,
} from '../src/index.js'

test('bytes to base64 encoding and decoding', () => {
  const bytes = new Uint8Array([1, 2, 3])
  const encoded = toB64(bytes)
  const decoded = fromB64(encoded)
  expect(equals(decoded, bytes)).toBe(true)
})

describe('toB64() padding', () => {
  test('emits no padding when byte length is multiple of 3', () => {
    expect(toB64(new Uint8Array([1, 2, 3]))).toBe('AQID')
  })

  test('emits single = when byte length mod 3 === 2', () => {
    expect(toB64(new Uint8Array([104, 105]))).toBe('aGk=')
  })

  test('emits double == when byte length mod 3 === 1', () => {
    expect(toB64(new Uint8Array([97]))).toBe('YQ==')
  })

  test('output matches strict base64 regex', () => {
    const re = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
    expect(re.test(toB64(new Uint8Array([1, 2, 3])))).toBe(true)
    expect(re.test(toB64(new Uint8Array([104, 105])))).toBe(true)
    expect(re.test(toB64(new Uint8Array([97])))).toBe(true)
  })
})

test('bytes to base64url encoding and decoding', () => {
  const bytes = new Uint8Array([1, 2, 3])
  const encoded = toB64U(bytes)
  const decoded = fromB64U(encoded)
  expect(equals(decoded, bytes)).toBe(true)
})

describe('toB64U() output', () => {
  test('emits no padding when byte length is a multiple of 3', () => {
    expect(toB64U(new Uint8Array([1, 2, 3]))).toBe('AQID')
  })

  test('emits no padding when byte length mod 3 === 2', () => {
    expect(toB64U(new Uint8Array([104, 105]))).toBe('aGk')
  })

  test('emits no padding when byte length mod 3 === 1', () => {
    expect(toB64U(new Uint8Array([97]))).toBe('YQ')
  })

  test('uses the URL-safe alphabet', () => {
    expect(toB64U(new Uint8Array([0xfb, 0xff]))).toBe('-_8')
  })

  test('output matches the strict unpadded base64url regex', () => {
    const re = /^[A-Za-z0-9_-]*$/
    expect(re.test(toB64U(new Uint8Array([1, 2, 3])))).toBe(true)
    expect(re.test(toB64U(new Uint8Array([104, 105])))).toBe(true)
    expect(re.test(toB64U(new Uint8Array([97])))).toBe(true)
    expect(re.test(toB64U(new Uint8Array([0xfb, 0xff])))).toBe(true)
  })

  test('round-trips through fromB64U at every residue length', () => {
    for (const bytes of [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([104, 105]),
      new Uint8Array([97]),
    ]) {
      expect(equals(fromB64U(toB64U(bytes)), bytes)).toBe(true)
    }
  })
})

test('UTF string to base64url encoding and decoding', () => {
  const text = 'foo bar'
  const encoded = b64uFromUTF(text)
  const decoded = b64uToUTF(encoded)
  expect(decoded).toBe(text)
})

test('JSON to base64url encoding and decoding', () => {
  const data = { foo: 'bar' }
  const encoded = b64uFromJSON(data)
  const decoded = b64uToJSON(encoded)
  expect(decoded).toEqual(data)
})

describe('fromB64U()', () => {
  test('rejects input containing whitespace', () => {
    expect(() => fromB64U('aGVs bG8')).toThrow('Invalid base64url')
  })

  test('accepts input containing padding characters', () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111])
    expect(equals(fromB64U('aGVsbG8='), bytes)).toBe(true)
    expect(equals(fromB64U('aGk='), new Uint8Array([104, 105]))).toBe(true)
    expect(equals(fromB64U('YQ=='), new Uint8Array([97]))).toBe(true)
  })

  test('rejects input with padding in invalid position', () => {
    expect(() => fromB64U('aGVs=bG8')).toThrow('Invalid base64url')
    expect(() => fromB64U('aGVsbG8===')).toThrow('Invalid base64url')
  })

  test('rejects input containing standard base64 characters', () => {
    expect(() => fromB64U('aGVs+G8')).toThrow('Invalid base64url')
    expect(() => fromB64U('aGVs/G8')).toThrow('Invalid base64url')
  })

  test('rejects input containing invalid characters', () => {
    expect(() => fromB64U('aGVs!G8')).toThrow('Invalid base64url')
    expect(() => fromB64U('aGVs@bG8#')).toThrow('Invalid base64url')
  })

  test('accepts valid base64url input', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111])
    const encoded = toB64U(bytes)
    expect(() => fromB64U(encoded)).not.toThrow()
  })

  test('accepts empty string', () => {
    expect(() => fromB64U('')).not.toThrow()
  })

  test('rejects a padding count that does not match dataLength % 4', () => {
    expect(() => fromB64U('YQ=')).toThrow('Invalid base64url')
    expect(() => fromB64U('A')).toThrow('Invalid base64url')
  })
})

describe('b64uToJSON()', () => {
  test('rejects deeply nested JSON exceeding depth limit', () => {
    const depth = 200
    const nested = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`
    const encoded = b64uFromUTF(nested)
    expect(() => b64uToJSON(encoded)).toThrow('exceeds maximum nesting depth')
  })

  test('rejects JSON at exactly depth 129', () => {
    const depth = 129
    const nested = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`
    const encoded = b64uFromUTF(nested)
    expect(() => b64uToJSON(encoded)).toThrow('exceeds maximum nesting depth')
  })

  test('accepts JSON at exactly depth 128', () => {
    const depth = 128
    const nested = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`
    const encoded = b64uFromUTF(nested)
    expect(b64uToJSON(encoded)).toBeDefined()
  })

  test('accepts JSON within depth limit', () => {
    const obj = { a: { b: { c: { d: 'value' } } } }
    const encoded = b64uFromJSON(obj)
    expect(b64uToJSON(encoded)).toEqual(obj)
  })
})

describe('canonicalStringify()', () => {
  test('produces deterministic key ordering', () => {
    const a = canonicalStringify({ z: 1, a: 2 })
    const b = canonicalStringify({ a: 2, z: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":2,"z":1}')
  })

  test('handles nested objects with deterministic ordering', () => {
    const result = canonicalStringify({ b: { d: 1, c: 2 }, a: 3 })
    expect(result).toBe('{"a":3,"b":{"c":2,"d":1}}')
  })

  test('handles arrays (preserves order)', () => {
    const result = canonicalStringify({ items: [3, 1, 2] })
    expect(result).toBe('{"items":[3,1,2]}')
  })

  test('handles primitive values', () => {
    expect(canonicalStringify('hello')).toBe('"hello"')
    expect(canonicalStringify(42)).toBe('42')
    expect(canonicalStringify(true)).toBe('true')
    expect(canonicalStringify(null)).toBe('null')
  })
})

describe('fromUTF() / toUTF()', () => {
  test('round-trips ASCII text', () => {
    const text = 'hello world'
    expect(toUTF(fromUTF(text))).toBe(text)
  })

  test('round-trips Unicode text', () => {
    const text = 'caf\u00e9 \u00fc\u00f1\u00efc\u00f6d\u00e9'
    expect(toUTF(fromUTF(text))).toBe(text)
  })

  test('round-trips multibyte characters', () => {
    const text = '\u4f60\u597d\u4e16\u754c'
    expect(toUTF(fromUTF(text))).toBe(text)
  })

  test('handles empty string', () => {
    const bytes = fromUTF('')
    expect(bytes.length).toBe(0)
    expect(toUTF(bytes)).toBe('')
  })

  test('fromUTF returns Uint8Array', () => {
    expect(fromUTF('test')).toBeInstanceOf(Uint8Array)
  })

  test('toUTF returns string', () => {
    expect(typeof toUTF(new Uint8Array([116, 101, 115, 116]))).toBe('string')
    expect(toUTF(new Uint8Array([116, 101, 115, 116]))).toBe('test')
  })

  test('round-trips a leading BOM instead of silently stripping it', () => {
    expect(toUTF(fromUTF('﻿hello'))).toBe('﻿hello')
  })

  test('round-trips a string that is only a BOM', () => {
    expect(toUTF(fromUTF('﻿'))).toBe('﻿')
  })

  test('base64url round-trip preserves a leading BOM', () => {
    expect(b64uToUTF(b64uFromUTF('﻿x'))).toBe('﻿x')
  })
})

describe('b64uFromJSON() canonicalize parameter', () => {
  test('canonicalize=true (default) produces deterministic output', () => {
    const a = b64uFromJSON({ z: 1, a: 2 })
    const b = b64uFromJSON({ a: 2, z: 1 })
    expect(a).toBe(b)
  })

  test('canonicalize=false uses standard JSON.stringify', () => {
    const result = b64uFromJSON({ z: 1, a: 2 }, false)
    const decoded = b64uToUTF(result)
    // JSON.stringify preserves insertion order
    expect(decoded).toBe('{"z":1,"a":2}')
  })

  test('canonicalize=true reorders keys', () => {
    const result = b64uFromJSON({ z: 1, a: 2 }, true)
    const decoded = b64uToUTF(result)
    expect(decoded).toBe('{"a":2,"z":1}')
  })
})

describe('toUTF() strictness', () => {
  test('throws on a lone invalid byte', () => {
    expect(() => toUTF(new Uint8Array([0xff]))).toThrow(TypeError)
  })

  test('throws on a truncated multibyte sequence rather than substituting U+FFFD', () => {
    expect(() => toUTF(new Uint8Array([0xc3, 0x28]))).toThrow(TypeError)
  })

  test('invalid UTF-8 propagates through b64uToUTF', () => {
    // '_w' is toB64U(new Uint8Array([0xff]))
    expect(() => b64uToUTF('_w')).toThrow(TypeError)
  })

  test('invalid UTF-8 propagates through b64uToJSON', () => {
    expect(() => b64uToJSON('_w')).toThrow(TypeError)
  })
})

describe('canonicalStringify() non-serializable values', () => {
  test('throws on undefined', () => {
    expect(() => canonicalStringify(undefined)).toThrow(TypeError)
  })

  test('throws on a function', () => {
    expect(() => canonicalStringify(() => {})).toThrow(TypeError)
  })

  test('throws on a symbol', () => {
    expect(() => canonicalStringify(Symbol('nope'))).toThrow(TypeError)
  })

  test('b64uFromJSON throws rather than encoding an empty string', () => {
    expect(() => b64uFromJSON(undefined as unknown as Record<string, unknown>)).toThrow(TypeError)
  })

  test('still drops object keys whose value is undefined', () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}')
  })
})

describe('fromB64()', () => {
  test('rejects input containing embedded whitespace', () => {
    // Both paths silently strip the space and decode anyway without the guard.
    // Embedded whitespace is a corruption signal, unlike surrounding whitespace, which is
    // trimmed before validation.
    expect(() => fromB64('aGVs bG8=')).toThrow('Invalid base64')
  })

  test('tolerates surrounding whitespace', () => {
    // Real-world shapes: a trailing newline from a file/env var, and leading+trailing spaces.
    const bytes = new Uint8Array([104, 101, 108, 108, 111])
    expect(equals(fromB64('aGVsbG8=\n'), bytes)).toBe(true)
    expect(equals(fromB64('  aGVsbG8=  '), bytes)).toBe(true)
  })

  test('rejects input containing an embedded newline', () => {
    // Line-wrapped/PEM-style base64. Rejecting it is intentional.
    expect(() => fromB64('aGVs\nbG8=')).toThrow('Invalid base64')
  })

  test('rejects input containing base64url characters', () => {
    expect(() => fromB64('aGVs-bG8')).toThrow('Invalid base64')
    expect(() => fromB64('aGVs_bG8')).toThrow('Invalid base64')
  })

  test('rejects input containing invalid characters', () => {
    expect(() => fromB64('aGVs!bG8')).toThrow('Invalid base64')
    expect(() => fromB64('aGVs@bG8#')).toThrow('Invalid base64')
  })

  test('rejects input with padding in an invalid position', () => {
    expect(() => fromB64('aGVs=bG8')).toThrow('Invalid base64')
    expect(() => fromB64('aGVsbG8===')).toThrow('Invalid base64')
  })

  test('accepts padded standard base64', () => {
    expect(equals(fromB64('AQID'), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(equals(fromB64('aGk='), new Uint8Array([104, 105]))).toBe(true)
    expect(equals(fromB64('YQ=='), new Uint8Array([97]))).toBe(true)
  })

  test('accepts the standard alphabet', () => {
    expect(equals(fromB64('+/8='), new Uint8Array([0xfb, 0xff]))).toBe(true)
  })

  test('accepts an empty string', () => {
    expect(() => fromB64('')).not.toThrow()
  })

  test('rejects whitespace-only input', () => {
    // Distinct from the empty string: trimming must not turn a non-empty, meaningless input
    // into a silently accepted empty result.
    expect(() => fromB64('   ')).toThrow('Invalid base64')
    expect(() => fromB64('\n')).toThrow('Invalid base64')
    expect(() => fromB64('\t')).toThrow('Invalid base64')
  })

  test('rejects a padding count that does not match dataLength % 4', () => {
    // The old regex checked alphabet and padding *shape* but not that the padding count
    // matched the data length, so these leaked past the guard and threw the decoder's own
    // error (SyntaxError / DOMException) instead of the documented Error.
    expect(() => fromB64('AB=')).toThrow('Invalid base64')
    expect(() => fromB64('A')).toThrow('Invalid base64')
    expect(() => fromB64('A==')).toThrow('Invalid base64')
    expect(() => fromB64('=')).toThrow('Invalid base64')
    expect(() => fromB64('AAAAA')).toThrow('Invalid base64')
  })
})

// Node 24 ships no `Uint8Array` base64 methods, so the codec runs the `atob` fallback there for
// real — every other test in this file exercises that path end to end on Node 24, and the native
// path on Node 26. The two tests below instead *delete* the natives to force the fallback on a
// runtime that has them; there is nothing to delete on Node 24, so they are skipped there rather
// than failing (or, worse, silently no-opping into a test that asserts nothing).
const HAS_NATIVE_BASE64 =
  typeof Uint8Array.prototype.toBase64 === 'function' && typeof Uint8Array.fromBase64 === 'function'

describe('atob fallback path', () => {
  test('fromB64atob decodes padded standard base64', () => {
    expect(equals(fromB64atob('AQID'), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(equals(fromB64atob('YQ=='), new Uint8Array([97]))).toBe(true)
  })

  test('fromB64Uatob decodes unpadded base64url', () => {
    expect(equals(fromB64Uatob('YQ'), new Uint8Array([97]))).toBe(true)
    expect(equals(fromB64Uatob('aGk'), new Uint8Array([104, 105]))).toBe(true)
  })

  test('fromB64Uatob still decodes padded base64url', () => {
    expect(equals(fromB64Uatob('YQ=='), new Uint8Array([97]))).toBe(true)
  })

  test('fromB64Uatob maps the URL-safe alphabet', () => {
    expect(equals(fromB64Uatob('-_8'), new Uint8Array([0xfb, 0xff]))).toBe(true)
  })

  test.skipIf(!HAS_NATIVE_BASE64)(
    'the encode fallback produces the same unpadded output as the native path',
    () => {
      const cases = [
        new Uint8Array([1, 2, 3]),
        new Uint8Array([104, 105]),
        new Uint8Array([97]),
        new Uint8Array([0xfb, 0xff]),
      ]
      const native = cases.map((bytes) => toB64U(bytes))

      const descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64')
      if (descriptor == null) {
        throw new Error('expected a native toBase64 to remove')
      }
      Reflect.deleteProperty(Uint8Array.prototype, 'toBase64')
      try {
        expect(typeof Uint8Array.prototype.toBase64).not.toBe('function')
        expect(cases.map((bytes) => toB64U(bytes))).toEqual(native)
        expect(native).toEqual(['AQID', 'aGk', 'YQ', '-_8'])
      } finally {
        Object.defineProperty(Uint8Array.prototype, 'toBase64', descriptor)
      }
    },
  )

  test.skipIf(!HAS_NATIVE_BASE64)(
    'the decode fallback (fromB64atob / fromB64Uatob) actually runs and is correct',
    () => {
      // The test above only ever deletes the encode *method* (Uint8Array.prototype.toBase64).
      // It never deletes the decode *static* (Uint8Array.fromBase64), so fromB64/fromB64U always
      // took the native branch and src/index.ts's fromB64atob(trimmed)/fromB64Uatob(...) lines
      // never executed. Deleting both natives here forces the fallback decode path to run.
      const toBase64Descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64')
      const fromBase64Descriptor = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64')
      if (toBase64Descriptor == null || fromBase64Descriptor == null) {
        throw new Error('expected native toBase64/fromBase64 to remove')
      }
      Reflect.deleteProperty(Uint8Array.prototype, 'toBase64')
      Reflect.deleteProperty(Uint8Array, 'fromBase64')
      try {
        expect(typeof Uint8Array.prototype.toBase64).not.toBe('function')
        expect(typeof Uint8Array.fromBase64).not.toBe('function')

        const bytes = new Uint8Array([104, 101, 108, 108, 111])
        // atob() strips ASCII whitespace itself, so this alone doesn't prove trimming is
        // load-bearing — fromB64atob(trimmed) and fromB64atob(base64) are indistinguishable here.
        expect(equals(fromB64('  aGVsbG8=  '), bytes)).toBe(true)
        // NBSP is stripped by trim() but rejected by atob() — this only passes if the trimmed
        // string is what reaches the fallback decoder.
        expect(equals(fromB64(' aGVsbG8= '), bytes)).toBe(true)
        expect(equals(fromB64U('aGVsbG8='), bytes)).toBe(true)
        expect(equals(fromB64U('aGVsbG8'), bytes)).toBe(true)

        expect(() => fromB64('aGVs bG8=')).toThrow('Invalid base64')
        expect(() => fromB64U('aGVs bG8')).toThrow('Invalid base64url')
      } finally {
        Object.defineProperty(Uint8Array.prototype, 'toBase64', toBase64Descriptor)
        Object.defineProperty(Uint8Array, 'fromBase64', fromBase64Descriptor)
      }
    },
  )
})
