# schema -- validator cache over isolated, recycled factories

**Status:** complete
**Date:** 2026-09-30
**Packages:** `@sozai/schema` (minor intent, from 0.1.3), gains a dependency on `@sozai/json`
**Requested by:** mokei (`@mokei/decision-flow-server` and `@mokei/host-desktop`)

Design: [spec](../../../superpowers/specs/2026-09-30-schema-validator-cache-design.md). The backlog
request was superseded by the spec and removed earlier (moved to `docs/superpowers/specs`).

## Why

mokei kept two near-identical module-private validator caches (one compile per distinct schema, a
compile bound per AJV instance, an LRU of validators). `createValidatorFactory` gave it the
isolated instance; the cache belongs next to it.

## Key design decisions

**Lives in `@sozai/schema`.** About 100 lines of source; the cost is the first `@sozai` dependency
of `schema` (`@sozai/json`, dependency-free).

**A closure over a `Map` used as the LRU.** A hit deletes and re-inserts its key; eviction removes
the first key. Built only on the public factory API.

**Key is the full canonical JSON, not a hash.** `canonicalizeJSON` throws `TypeError` for values
that are not plain JSON (`toJSON`, `undefined` properties), so every key maps to one compiled
shape. A hash could collide, and tool schemas come from MCP servers.

**Compiles a snapshot.** On a miss the cache compiles `JSON.parse(key)`, so a validator never
disagrees with its key even if the caller mutates the schema object. `ValidationError.schema` is
the snapshot and issues follow sorted key order.

**Compile errors are always cached**, rethrown as the same `Error` until evicted or recycled.
No `cacheErrors` option.

**Lifecycle matches the factory.** `clear()` resets and stays usable; `dispose()` is terminal. A
hit never recycles; the first miss after `maxCompiles` compiles disposes and replaces the factory.

**`compileValidator` leaves the registry as it found it.** After every compile, success or
failure, everything not in the instance's baseline keys (`ajv.schemas`, `ajv.refs`) is removed, so
a failed compile or a nested `$id` no longer blocks a later schema, on the shared instances and
on factories. A root `$id` equal to a meta-schema id throws `Schema $id <id> is reserved`. Schemas
must be self-contained (no cross-schema `$ref`).

**Boolean schemas** (cast to `Schema`) compile on `createValidator`, the factory and the cache
instead of throwing `Invalid value used as weak map key`; they skip the `WeakMap`.

## What was built

- `createValidatorCache`, with `ValidatorCache`, `ValidatorCacheOptions` and `ValidatorCacheStats`
  exported from `@sozai/schema`; defaults `maxCompiles: 256`, `maxEntries: 64`; `RangeError` for
  bounds that are not integers of at least 1.
- The `compileValidator` cleanup, reserved-`$id` guard and boolean handling in `validation.ts`, with
  tests in `lib.test.ts` for both `createValidator` and the factory.
- `test/cache.test.ts`, README and `sozai:validation` skill reference and `SKILL.md` updates, and a
  minor change intent.

## Consumer

Once released, mokei replaces `src/validators.ts` in `@mokei/decision-flow-server` and the cache
in `@mokei/host-desktop`'s `src/form.ts` with `createValidatorCache`; host-desktop passes
`{ factory: { draft: '2020-12', strict: false } }`.

## Out of scope

- Boolean schemas in `toStandardValidator` and `createStandardValidator`.
- A validator-factory option in `FlowGraphOptions` for `@sozai/flow-graph`.
