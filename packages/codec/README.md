# @sozai/codec

Base64 / UTF-8 / JSON encoding and canonical stringify.

## Installation

```sh
pnpm add @sozai/codec
```

## Usage

```ts
import { toB64U, fromB64U, b64uFromJSON, b64uToJSON, canonicalStringify } from '@sozai/codec'

const bytes = new Uint8Array([104, 101, 108, 108, 111]) // "hello"

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

Also provides `toB64`/`fromB64`, `fromUTF`/`toUTF`, and `b64uFromUTF`/`b64uToUTF` — see [the codec reference](../../plugins/sozai/skills/validation/reference/codec.md) (part of the `sozai:validation` skill) for the full API.
