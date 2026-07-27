# @sozai/schema

## Exports

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
| `resolveReference` | function | Resolve a `$ref` pointer string against a root schema |
| `resolveSchema` | function | Resolve a schema's `$ref` via `resolveReference`, or return it unchanged |

## Example

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
