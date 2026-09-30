# @sozai/schema

## Exports

| Export | Kind | Description |
|---|---|---|
| `Schema` | type | JSON Schema definition type |
| `FromSchema` | type | Derive TypeScript type from schema |
| `Validator` | type | Validator function type |
| `ValidatorFactory` | type | Isolated validator factory with `createValidator`, `compiled`, `dispose` |
| `ValidatorFactoryOptions` | type | Factory options: `draft`, `strict`, `logger` (`false` silences AJV warnings) |
| `ValidatorCache` | type | Bounded validator cache with `get`, `stats`, `clear`, `dispose` |
| `ValidatorCacheOptions` | type | Cache options: `factory`, `maxCompiles` (default 256), `maxEntries` (default 64) |
| `ValidatorCacheStats` | type | `generation`, `compiles`, `entries` |
| `ValidatorLogger` | type | Logger receiving AJV warnings |
| `StandardSchemaV1` | type | Standard Schema v1 interface |
| `ValidationError` | class | AggregateError with validation issues |
| `ValidationErrorObject` | class | Single issue with AJV error details |
| `createValidator` | function | Build reusable validator from schema |
| `createValidatorFactory` | function | Own a disposable AJV instance for runtime schemas |
| `createValidatorCache` | function | LRU of validators over recycled isolated factories, for runtime schemas |
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

## Runtime schemas

`createValidator` compiles on AJV instances shared by the whole process, which keep every compiled
validator for the life of the process. For schemas that arrive at runtime, use a cache: it owns
isolated factories, reuses one compile per distinct schema (key order ignored), caches compile
errors, and disposes and replaces the factory after `maxCompiles` distinct compiles.

```typescript
import { createValidatorCache } from '@sozai/schema'

const cache = createValidatorCache({
  factory: { draft: '2020-12', strict: false, logger: false },
  maxCompiles: 256, // distinct compiles per factory before it is replaced
  maxEntries: 64, // validators kept, least recently used evicted first
})

const validate = cache.get(toolInputSchema) // throws the compile error if the schema is invalid
cache.stats() // { generation, compiles, entries }
cache.dispose() // later get() calls throw
```

For finer control, `createValidatorFactory()` gives one isolated instance with `compiled` and
`dispose()`. Validators already returned keep working after `dispose()` and keep their instance
alive until they are dropped too.

- A validator checks a snapshot of the schema, so `ValidationError.schema` is that snapshot (equal to, not the same object as, the input) and its issues follow sorted key order.
- Schemas must be self-contained: every compile leaves the instance as it found it, so `$ref` to another schema's `$id` does not resolve. A `$ref` to a location inside the same schema works.
- A root `$id` equal to a meta-schema id is rejected with `Schema $id <id> is reserved`.
- A boolean schema, cast to `Schema`, is accepted by `createValidator`, the factory and the cache.

> Look a validator up at the moment of use, and do not hold it longer than needed. A long-lived
> holder, such as a suspended run keeping a validator, keeps its disposed AJV instance alive.
