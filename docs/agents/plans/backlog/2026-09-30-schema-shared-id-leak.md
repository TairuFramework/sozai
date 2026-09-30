# schema -- failed compile leaks `$id` on the shared AJV instances

**Status:** open · bug
**Package:** `@sozai/schema`
**Found by:** Codex review of the [validator cache spec](./2026-09-30-schema-validator-cache.md)

## Problem

`compileValidator` in `packages/schema/src/validation.ts` removes a schema's root `$id` from AJV
only after a successful compile. AJV registers the `$id` before compiling, so a failed compile of
a schema with `$id: "x"` leaves `"x"` registered. On the shared, process-wide instances behind
`createValidator`, every later compile of any schema with `$id: "x"` then fails with "already
exists", for the life of the process. Nested `$id`s are never removed, even after a successful
compile, with the same effect.

The validator cache spec fixes this for `createValidatorFactory` by clearing the factory's registry
after every compile. The shared instances need their own fix.

## Options

- Remove the root `$id` in a `finally`, so failed compiles clean up too. Does not cover nested ids.
- Call `ajv.removeSchema()` (no argument) after every compile, as the factory will. Covers nested
  ids, but also drops AJV's compile cache on an instance other packages share; check that no
  consumer registers schemas on it for cross-schema `$ref`.

## Tests

- a failed compile with `$id: 'x'` does not block a later valid schema with `$id: 'x'`;
- two distinct schemas with the same nested `$id` both compile through `createValidator`.
