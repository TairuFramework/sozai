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

Also provides `assertType`, `asType`, `createStandardValidator`, `resolveSchema`, and more — see [the validation reference](../../docs/reference/validation.md) for the full API.
