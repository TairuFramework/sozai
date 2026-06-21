---
name: sozai:validation
description: Schema validation, type generation, and encoding/decoding patterns
---

# Sozai Schema & Validation

## Packages in This Domain

**JSON Schema Validation**: `@sozai/schema`

**Encoding/Decoding**: `@sozai/codec`

## Key Patterns

### Pattern 1: Define Schema with Type Generation

```typescript
import type { Schema, FromSchema } from '@sozai/schema'

// Define schema with type safety
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

// Generate TypeScript type from schema
type User = FromSchema<typeof userSchema>
// Result: { name: string; age?: number; email: string; role?: 'admin' | 'user' | 'guest' }
```

**Use case**: Define data shapes once, use everywhere with compile-time and runtime safety

**Key points**:
- `Schema` type ensures valid JSON Schema definition
- `as const` assertion required for type inference
- `FromSchema` generates TypeScript type from schema
- Supports all JSON Schema features: required, optional, enums, formats
- Type generation respects constraints (enums become literal unions)

### Pattern 2: Runtime Validation with Validators

```typescript
import { createValidator, assertType, isType, asType } from '@sozai/schema'
import type { Schema, FromSchema } from '@sozai/schema'

const configSchema = {
  type: 'object',
  properties: {
    port: { type: 'number', minimum: 1, maximum: 65535 },
    host: { type: 'string' },
    debug: { type: 'boolean' },
  },
  required: ['port', 'host'],
  additionalProperties: false,
} as const satisfies Schema

type Config = FromSchema<typeof configSchema>

// Create validator function
const validateConfig = createValidator<typeof configSchema, Config>(configSchema)

// Three validation approaches:

// 1. Type guard: Returns boolean
const data1: unknown = { port: 3000, host: 'localhost', debug: true }
if (isType(validateConfig, data1)) {
  // data1 is now typed as Config
  console.log(data1.port)
}

// 2. Assertion: Throws on failure
const data2: unknown = { port: 8080, host: '0.0.0.0' }
assertType(validateConfig, data2)
// data2 is now asserted as Config
console.log(data2.host)

// 3. Convert and assert: Returns typed value
const data3: unknown = { port: 5000, host: 'example.com' }
const config: Config = asType(validateConfig, data3)
```

**Use case**: Validate untrusted input, parse configuration, enforce data contracts

**Key points**:
- `createValidator()` builds reusable validator from schema
- Returns Standard Schema v1 Result type
- `isType()` for type guards (non-throwing)
- `assertType()` for assertions (throws `ValidationError`)
- `asType()` combines assertion with return
- Validates and narrows types simultaneously

### Pattern 3: Validation Error Handling

```typescript
import { createValidator, ValidationError } from '@sozai/schema'
import type { Schema } from '@sozai/schema'

const productSchema = {
  type: 'object',
  properties: {
    price: { type: 'number', minimum: 0 },
  },
  required: ['price'],
  additionalProperties: false,
} as const satisfies Schema

const validateProduct = createValidator(productSchema)

const result = validateProduct({ price: -10, extra: 'field' })
if (result instanceof ValidationError) {
  for (const issue of result.issues) {
    console.log(issue.path.join('.'), issue.message)
  }
}
```

**Use case**: Detailed error reporting, input validation responses, debugging schema mismatches

**Key points**:
- `ValidationError` aggregates all issues in one pass (not fail-fast); `result.value` preserves the original input
- Each issue exposes `path` (field location as string array) and `message`

### Pattern 4: Base64 Encoding for Binary Data

```typescript
import { toB64, fromB64, toB64U, fromB64U } from '@sozai/codec'
import { fromUTF, toUTF, b64uFromUTF, b64uToUTF } from '@sozai/codec'

// Standard Base64 encoding
const data = new Uint8Array([104, 101, 108, 108, 111]) // "hello"
const encoded = toB64(data)   // "aGVsbG8="
const decoded = fromB64(encoded) // Uint8Array([104, 101, 108, 108, 111])

// URL-safe Base64 encoding (no padding, URL-safe chars)
const urlEncoded = toB64U(data)  // "aGVsbG8" (no padding)
const urlDecoded = fromB64U(urlEncoded)

// UTF-8 string to bytes and back
const text = 'Hello, world!'
const bytes = fromUTF(text)      // Uint8Array
const recovered = toUTF(bytes)   // 'Hello, world!'

// Direct UTF-8 to Base64URL
const b64str = b64uFromUTF('Hello!') // "SGVsbG8h"
const original = b64uToUTF(b64str)   // "Hello!"
```

**Use case**: Binary data in JSON/URLs, URL-safe encoding, byte/string conversion

**Key points**:
- `toB64/fromB64` for standard Base64 with padding
- `toB64U/fromB64U` for URL-safe Base64 (RFC 4648 §5)
- `fromUTF/toUTF` for UTF-8 ↔ `Uint8Array` conversion
- `b64uFromUTF/b64uToUTF` for direct string ↔ Base64URL
- Handles Unicode correctly via `TextEncoder`/`TextDecoder`

### Pattern 5: JSON Canonicalization and Encoding

```typescript
import { b64uFromJSON, b64uToJSON, canonicalStringify } from '@sozai/codec'

type EventPayload = {
  id: string
  source: string
  ts: number
  data: Record<string, unknown>
}

const payload: EventPayload = {
  source: 'sensor-42',
  id: 'evt-001',
  ts: 1234567890,
  data: { value: 3.14 },
}

// Canonical encoding (keys sorted, RFC 8785 — deterministic)
const canonical = b64uFromJSON(payload, true)
// Same input always produces identical output

// Non-canonical encoding (fast, insertion-order keys)
const fast = b64uFromJSON(payload, false)

// Decode back to typed object
const recovered = b64uToJSON<EventPayload>(canonical)
console.log(recovered.source) // "sensor-42"

// Direct canonical stringify (deterministic JSON for signatures)
const a = { z: 1, a: 2 }
const b = { a: 2, z: 1 }
canonicalStringify(a) === canonicalStringify(b) // true
```

**Use case**: Deterministic JSON for content addressing or signatures; round-trip objects through Base64URL

**Key points**:
- `b64uFromJSON(obj, true)` uses RFC 8785 canonical JSON — same data, same encoding
- `b64uFromJSON(obj, false)` is faster when order does not matter
- `b64uToJSON<T>()` decodes and parses in one step with generic type parameter
- `canonicalStringify()` exposes canonical serialization for use outside Base64 contexts

## When to Use What

**Use `@sozai/schema`** when:
- Validating untrusted input (user data, config files, deserialized payloads)
- Defining data shapes shared across the codebase
- Need compile-time AND runtime type safety from one schema
- Generating TypeScript types via `FromSchema`
- Integrating with the Standard Schema v1 ecosystem
- Collecting all validation errors rather than failing on the first

**Use `@sozai/codec`** when:
- Encoding binary data for transmission in JSON or URLs
- Converting between UTF-8 strings and byte arrays
- Need deterministic JSON for content addressing or signatures
- Round-tripping objects through Base64URL without manual JSON steps

## Related Domains

- See `sozai:dataflow` for stream and event processing that produces validated payloads
- See `sozai:runtime` for environment-specific I/O where codec handles binary serialization
- See `sozai:observability` for structured log/metric schemas validated at definition time
- See `sozai:primitives` for base utilities used by schema and codec internally

## Domain Reference

For the domain reference: `docs/domains/validation.md`
