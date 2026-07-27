# @sozai/codec

## Exports

| Export | Kind | Description |
|---|---|---|
| `toB64` | function | Encode `Uint8Array` to standard Base64 (padded) |
| `fromB64` | function | Decode standard Base64 to `Uint8Array` |
| `toB64U` | function | Encode `Uint8Array` to URL-safe Base64 (no padding) |
| `fromB64U` | function | Decode URL-safe Base64 to `Uint8Array` |
| `fromUTF` | function | Encode UTF-8 string to `Uint8Array` |
| `toUTF` | function | Decode `Uint8Array` to UTF-8 string |
| `b64uFromUTF` | function | Encode UTF-8 string directly to Base64URL |
| `b64uToUTF` | function | Decode Base64URL directly to UTF-8 string |
| `b64uFromJSON` | function | Encode object to Base64URL (optionally canonical) |
| `b64uToJSON` | function | Decode Base64URL string to typed object (depth-limited) |
| `canonicalStringify` | function | Deterministic JSON stringify (RFC 8785) |

## Example

```typescript
import {
  toB64, fromB64, toB64U, fromB64U,
  fromUTF, toUTF, b64uFromUTF, b64uToUTF,
  b64uFromJSON, b64uToJSON, canonicalStringify,
} from '@sozai/codec'

// --- Base64 round-trips ---

const bytes = new Uint8Array([104, 101, 108, 108, 111]) // "hello"

const std = toB64(bytes)       // "aGVsbG8="   (padded)
fromB64(std)                   // Uint8Array([104, 101, 108, 108, 111])

const url = toB64U(bytes)      // "aGVsbG8"    (URL-safe, no padding)
fromB64U(url)                  // Uint8Array([104, 101, 108, 108, 111])

// --- UTF-8 ↔ bytes ---

const text = 'Hello, world!'
const encoded = fromUTF(text)  // Uint8Array
toUTF(encoded)                 // 'Hello, world!'

b64uFromUTF('Hello!')          // 'SGVsbG8h'
b64uToUTF('SGVsbG8h')         // 'Hello!'

// --- JSON ↔ Base64URL ---

type Entry = { id: string; value: number }
const obj: Entry = { id: 'abc', value: 42 }

const fast      = b64uFromJSON(obj, false) // fast, insertion order
const canonical = b64uFromJSON(obj, true)  // deterministic (RFC 8785)

b64uToJSON<Entry>(canonical)  // { id: 'abc', value: 42 }

// --- Canonical stringify for deterministic JSON ---

const a = { z: 1, a: 2 }
const b = { a: 2, z: 1 }
canonicalStringify(a) === canonicalStringify(b) // true — keys sorted
```

## Example: decode error paths

`fromB64` trims surrounding whitespace before validating (base64 routinely arrives from files or env vars with a
trailing newline), but throws on embedded whitespace or an invalid alphabet/padding. `fromB64U` does **not**
trim — its input is JWT segments off the wire, where whitespace is always corruption — but it accepts padded
input for lenient decoding of older tokens. `toUTF` uses a fatal `TextDecoder` and throws a `TypeError` on
invalid UTF-8, so corrupted bytes never silently decode to a plausible string; `fromUTF` has no such encode-side
guard and replaces lone surrogates with U+FFFD per the `TextEncoder` contract. A leading BOM (U+FEFF)
round-trips intact through `fromUTF`/`toUTF` — it is not stripped. `b64uToJSON` rejects payloads nested deeper
than 128 levels with `Error('JSON exceeds maximum nesting depth of 128')`, checked before parsing.

```typescript
import { fromB64, fromB64U, toUTF } from '@sozai/codec'

fromB64('aGVsbG8=\n')     // OK — trailing newline trimmed before validation
fromB64U('aGVsbG8=')      // OK — fromB64U tolerates padding for older tokens

try {
  fromB64('aGVs bG8=')    // embedded whitespace is rejected
} catch (err) {
  console.log((err as Error).message) // 'Invalid base64 encoding'
}

try {
  fromB64U('aGVsbG8 ')    // trailing whitespace is NOT trimmed here
} catch (err) {
  console.log((err as Error).message) // 'Invalid base64url encoding'
}

try {
  toUTF(new Uint8Array([0xff])) // not valid UTF-8
} catch (err) {
  console.log(err instanceof TypeError) // true
}
```

## Example: canonicalStringify error paths

`canonicalStringify` delegates to `@sozai/json` and throws a `TypeError` on values
`JSON.stringify` would silently mangle or reject: `'NaN is not allowed'`,
`'Infinity is not allowed'`, `'BigInt is not allowed'`, `'Circular reference detected'`.
Plain `JSON.stringify` (used by `b64uFromJSON` when `canonicalize` is `false`) instead silently
turns `NaN`/`Infinity` into `null`, so the two `b64uFromJSON` modes diverge on more than key order.

```typescript
import { canonicalStringify, b64uFromJSON } from '@sozai/codec'

try {
  canonicalStringify({ a: Number.NaN })
} catch (err) {
  console.log((err as Error).message) // 'NaN is not allowed'
}

// canonical mode throws on NaN; non-canonical mode silently encodes it as null
b64uFromJSON({ a: Number.NaN }, false) // succeeds — decodes back to { a: null }
```
