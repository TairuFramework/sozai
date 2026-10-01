# @sozai/schema

JSON Schema validation and `FromSchema` type generation.

## Installation

```sh
pnpm add @sozai/schema
```

## Usage

```ts
import type { Schema, FromSchema } from '@sozai/schema'
import { createValidator, isType, ValidationError } from '@sozai/schema'

// Define a schema — the single source of truth for the shape
const userSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number', minimum: 18 },
  },
  required: ['name'],
  additionalProperties: false,
} as const satisfies Schema

// Derive the TypeScript type — no duplication
type User = FromSchema<typeof userSchema>

// Build a reusable validator
const validateUser = createValidator<typeof userSchema, User>(userSchema)

const raw: unknown = JSON.parse('{"name":"Ada","age":36}')
if (isType(validateUser, raw)) {
  console.log(raw.name) // `raw` is narrowed to User
}

const result = validateUser({ name: 'bad', age: 10 })
if (result instanceof ValidationError) {
  for (const issue of result.issues) {
    console.log(issue.path.join('.'), issue.message)
  }
}
```

For schemas that arrive at runtime, `createValidatorFactory()` owns an isolated AJV instance: `dispose()` drops the instance and every validator it memoised, which the shared instances behind `createValidator` keep for the life of the process. Validators already returned keep working and keep the instance alive until they are dropped too.

`createValidatorCache()` builds on it: a bounded LRU of validators over factories that are disposed and replaced after `maxCompiles` distinct compiles. Schemas equal up to key order share one compile, and a failed compile is cached. `dispose()` is terminal: later `get` calls throw, and `disposed` reports it.

```ts
import { createValidatorCache } from '@sozai/schema'

const cache = createValidatorCache({ factory: { strict: false, logger: false } })

const validate = cache.get({ type: 'string', minLength: 1 })
cache.stats() // { generation: 0, compiles: 1, entries: 1 }
```

- A validator checks a snapshot of the schema, so `ValidationError.schema` is that snapshot (equal to, not the same object as, the input) and its issues follow sorted key order.
- Schemas must be self-contained: every compile leaves the instance as it found it, so `$ref` to another schema's `$id` does not resolve. A `$ref` to a location inside the same schema works.
- A root `$id` equal to a meta-schema id is rejected with `Schema $id <id> is reserved`.
- A boolean schema, cast to `Schema`, is accepted by `createValidator`, the factory and the cache.

> Look a validator up at the moment of use, and do not hold it longer than needed. A long-lived
> holder, such as a suspended run keeping a validator, keeps its disposed AJV instance alive.

Also provides `assertType`, `asType`, `createStandardValidator`, `resolveSchema`, and more — see [the schema reference](../../plugins/sozai/skills/validation/reference/schema.md) (part of the `sozai:validation` skill) for the full API.
