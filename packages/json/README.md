# @sozai/json

Canonical JSON serialization (RFC 8785) and hardened parsing.

## Installation

```sh
npm install @sozai/json
```

## Usage

```ts
import { canonicalize, parse } from '@sozai/json'

// Deterministic output regardless of insertion order — for signing and content addressing.
canonicalize({ z: 1, a: 2 }) // '{"a":2,"z":1}'

// Returns undefined when the value itself has no JSON representation.
canonicalize(undefined) // undefined

// Throws a TypeError on NaN, Infinity, BigInt and circular references.

// Depth-limited parsing, checked before JSON.parse runs.
parse('{"a":1}') // { a: 1 }
parse(deeplyNested, { maxDepth: 32 })

// Optional guard for keys that pollute prototypes when the result is merged.
parse(untrusted, { protoKeys: 'strip' })
```
