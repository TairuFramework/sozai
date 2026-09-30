# schema -- isolated, disposable validator instances

**Status:** complete
**Date:** 2026-09-30
**Packages:** `@sozai/schema` (minor intent, from 0.1.2)
**Requested by:** mokei (`@mokei/host-desktop`), for schemas that MCP servers send at runtime

Bounded change designed in chat; no spec or plan file existed.

## Why

`createValidator` compiles on one AJV instance per `(draft, strict)` pair, shared by the whole
process. AJV's code-gen `scope` keeps every compiled `validate` function and every `schema` value
for the life of the instance, even when `removeSchema($id)` clears the schema caches. mokei measured
about 9 KB retained per compile for one-off schemas (20,000 compiles grew the heap by about 177 MB).
Nothing in the public API released that memory, and mokei did not want a direct `ajv` dependency.

## Key design decisions

**One owned instance per factory.** `createValidatorFactory({ draft?, strict?, logger? })` builds its
own AJV instance with `ajv-formats` and shares nothing with the default instances or with other
factories. Draft, strict and logger are fixed per factory, so its `createValidator(schema)` takes no
per-call options.

**Dispose drops, it does not revoke.** `dispose()` drops the instance and the memo, and is
idempotent. Later `createValidator` calls throw `Validator factory is disposed`. Validators already
returned keep working; each references its instance, so memory frees once the caller drops them too.

**Recycle by count.** `compiled` counts actual compiles, not memoized lookups, so a caller can
dispose and replace the factory after N compiles without tracking that itself. The factory memoizes
validators in a `WeakMap` keyed by schema object, like the default path.

**`$id` reuse stays safe.** Both paths share one compile helper that calls `removeSchema($id)` after
compiling, so distinct schemas with the same `$id` compile on one instance without a duplicate-id
error. `removeSchema` is never called without an `$id`, which would clear the whole instance.

**Logger control.** `logger: false` silences AJV warnings, such as unknown formats under non-strict
mode; a `ValidatorLogger` (`log`, `warn`, `error`) receives them instead.

**Default path unchanged.** `createValidator` keeps its shared instances and memo for schemas
defined in code. A factory `createStandardValidator` was left out: `toStandardValidator(validator,
schema, { draft })` already covers it.

## What was built

- `createValidatorFactory`, with the `ValidatorFactory`, `ValidatorFactoryOptions` and
  `ValidatorLogger` types exported from `@sozai/schema`.
- Tests for draft and strict options, isolation, the compile count, `$id` reuse, `dispose`, and
  both logger modes. No GC-based memory test, which would be flaky.
- README and `sozai:validation` skill reference, including a recycle-after-N-compiles example.

## Consumer

mokei `packages/host-desktop/src/form.ts` can create a factory, recycle it every N distinct compiles
and drop its validator LRU at the same time, once `@sozai/schema` is released.
