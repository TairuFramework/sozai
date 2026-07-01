# Validation

JSON Schema validation, type generation, and encoding/decoding for the sozai layer.

## Packages

| Package | Purpose |
|---|---|
| `@sozai/schema` | JSON Schema validation and `FromSchema` type generation |
| `@sozai/codec` | Base64 / UTF-8 / JSON encoding and canonical stringify |

---

## @sozai/schema

### Exports

| Export | Kind | Description |
|---|---|---|
| `Schema` | type | JSON Schema definition type |
| `FromSchema` | type | Derive TypeScript type from schema |
| `Validator` | type | Validator function type |
| `StandardSchemaV1` | type | Standard Schema v1 interface |
| `ValidationError` | class | AggregateError with validation issues |
| `ValidationErrorObject` | class | Single issue with AJV error details |
| `createValidator` | function | Build reusable validator from schema |
| `createStandardValidator` | function | Build Standard Schema v1 validator |
| `toStandardValidator` | function | Wrap validator as Standard Schema v1 |
| `assertType` | function | Assert value matches schema; throws on failure |
| `asType` | function | Assert and return typed value |
| `isType` | function | Type guard; returns boolean |
| `resolveReference` | function | Resolve `$ref` in a schema |
| `resolveSchema` | function | Fully resolve a schema with references |

### Example

```typescript
import type { Schema, FromSchema } from '@sozai/schema'
import { createValidator, isType, assertType, asType, ValidationError } from '@sozai/schema'

// 1. Define schema — single source of truth for shape
const userSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number', minimum: 18, maximum: 120 },
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['admin', 'user', 'guest'] },
  },
  required: ['name', 'email'],
  additionalProperties: false,
} as const satisfies Schema

// 2. Derive TypeScript type — no duplication
type User = FromSchema<typeof userSchema>
// { name: string; age?: number; email: string; role?: 'admin' | 'user' | 'guest' }

// 3. Create a reusable validator
const validateUser = createValidator<typeof userSchema, User>(userSchema)

// 4a. Type guard (non-throwing)
const raw: unknown = JSON.parse('{"name":"Ada","email":"ada@example.com"}')
if (isType(validateUser, raw)) {
  console.log(raw.name) // TypeScript knows `raw` is User
}

// 4b. Assertion (throws ValidationError) — use when input must be valid
const trusted: unknown = JSON.parse('{"name":"Ada","email":"ada@example.com"}')
assertType(validateUser, trusted)
console.log(trusted.name) // trusted is now narrowed to User

// 4c. Assert and return — handy in pipelines
const user: User = asType(validateUser, JSON.parse('{"name":"Ada","email":"ada@example.com"}'))

// 5. Structured error handling
const result = validateUser({ name: 'bad', age: 10 })
if (result instanceof ValidationError) {
  for (const issue of result.issues) {
    console.log(issue.path.join('.'), issue.message)
  }
}
```

---

## @sozai/codec

### Exports

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
| `b64uToJSON` | function | Decode Base64URL string to typed object |
| `canonicalStringify` | function | Deterministic JSON stringify (RFC 8785) |

### Example

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

---

## When to Use

**Use `@sozai/schema`** when you need to:
- Validate untrusted input — user data, config files, deserialized payloads
- Derive TypeScript types from a single schema definition (`FromSchema`)
- Enforce both compile-time and runtime type safety
- Integrate with the Standard Schema v1 ecosystem
- Collect all validation errors in one pass rather than fail-fast

**Use `@sozai/codec`** when you need to:
- Encode binary data for transmission in JSON or URLs
- Convert between UTF-8 strings and byte arrays
- Produce deterministic JSON for content addressing or signatures
- Round-trip objects through Base64URL without manual JSON steps

---

## See Also

- `sozai:dataflow` — stream and event processing that produces validated payloads
- `sozai:runtime` — environment-specific I/O where codec handles binary serialization
- `sozai:observability` — structured log/metric schemas validated at definition time
- `sozai:primitives` — base utilities used by schema and codec internally
