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

// Strict variant for values that must round-trip exactly: always returns a string.
import { canonicalizeJSON, isJSONValue, type JSONValue } from '@sozai/json'

isJSONValue({ a: [1, null] }) // true
isJSONValue(new Date()) // false: class instances, toJSON, holes and accessors are rejected
canonicalizeJSON({ z: 1, a: 2 }) // '{"a":2,"z":1}', throws a TypeError on non-JSON values

// Depth-limited parsing, checked before JSON.parse runs.
parse('{"a":1}') // { a: 1 }
parse(deeplyNested, { maxDepth: 32 })

// Optional guard for keys that pollute prototypes when the result is merged.
parse(untrusted, { protoKeys: 'strip' })
```
