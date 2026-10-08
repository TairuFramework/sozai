# @sozai/codec

Base32 / Base64 / UTF-8 / JSON encoding and canonical stringify.

## Installation

```sh
pnpm add @sozai/codec
```

## Usage

```ts
import {
  toB32, fromB32, toB64U, fromB64U, b64uFromJSON, b64uToJSON, canonicalStringify,
} from '@sozai/codec'

const bytes = new Uint8Array([104, 101, 108, 108, 111]) // "hello"

// Bytes <-> lowercase Base32 (unpadded, RFC 4648)
const base32 = toB32(bytes) // 'nbswy3dp'
fromB32(base32) // Uint8Array([104, 101, 108, 108, 111])

// Bytes <-> URL-safe Base64 (unpadded, RFC 7515)
const url = toB64U(bytes) // 'aGVsbG8'
fromB64U(url) // Uint8Array([104, 101, 108, 108, 111])

// Object <-> Base64URL, canonical by default (deterministic key order)
type Entry = { id: string; value: number }
const token = b64uFromJSON({ id: 'abc', value: 42 } satisfies Entry)
b64uToJSON<Entry>(token) // { id: 'abc', value: 42 }

// Deterministic JSON for content addressing / signatures (RFC 8785)
canonicalStringify({ z: 1, a: 2 }) === canonicalStringify({ a: 2, z: 1 }) // true
```

`fromB32` accepts lowercase, unpadded input only. It rejects whitespace, uppercase, padding and impossible lengths.
Unused bits must be zero by default. Pass `{ strict: false }` to ignore them.
Callers wanting case-insensitive input must lowercase it first.

Also provides `toB64`/`fromB64`, `fromUTF`/`toUTF`, and `b64uFromUTF`/`b64uToUTF` — see [the codec reference](../../plugins/sozai/skills/validation/reference/codec.md) (part of the `sozai:validation` skill) for the full API.
