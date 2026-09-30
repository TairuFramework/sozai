# schema -- validator cache over isolated, recycled factories

**Status:** design approved · spec awaiting review
**Date:** 2026-09-30
**Package:** `@sozai/schema` (minor, from 0.1.3), gains a dependency on `@sozai/json`
**Requested by:** mokei (`@mokei/decision-flow-server` and `@mokei/host-desktop`)

## Why

`createValidatorFactory` (`@sozai/schema` 0.1.3) gives a consumer an isolated AJV instance it
can `dispose()`. That keeps AJV's code-gen scope from growing for the life of the process, but
only if the consumer also bounds how many schemas it compiles on one instance. Consumers that
validate runtime schemas (MCP tool input and output schemas, elicitation forms) need three
things on top of the factory:

- one compile per distinct schema, whatever the key order;
- a bound on the number of compiles per instance, with the instance replaced when the bound is
  reached;
- a bound on the number of validators kept in memory.

mokei implements this twice today, as near-identical module-private code in
`@mokei/decision-flow-server` (`src/validators.ts`) and `@mokei/host-desktop` (`src/form.ts`).
It belongs next to the factory.

## Key design decisions

**It lives in `@sozai/schema`, not a new package.** The cache is about 100 lines of source on a
package of about 400. A separate package would need more scaffolding than logic. The cost is
the first `@sozai` dependency of `schema`: `@sozai/json`, which has no dependencies of its own
and which existing consumers such as `flow-graph` already install.

**A closure over a `Map` used as the LRU.** A `Map` keeps insertion order, so a hit deletes and
re-inserts its key, and eviction removes the first key. This is mokei's implementation, in the
closure style of `createValidatorFactory`. No class, no new data structure.

**The key is the full canonical JSON, not a hash.** At most `maxEntries` keys exist, and each
validator already keeps its schema and AJV's generated code alive, which are larger than the key.
`get` is synchronous, so a cryptographic digest is not available without a new dependency. A
fast non-cryptographic hash can collide, and a collision would validate data against another
schema; tool schemas come from MCP servers, so a collision can be crafted. Guarding against it
means keeping the full key anyway.

**No identity fast path.** `canonicalize` runs on every `get`, hits included. A
`WeakMap<Schema, string>` would skip it for a repeated schema object, but both known consumers
build a fresh schema object per request, and the fast path would bring back the
mutated-after-first-use caveat of `createValidator`. It can be added later without an API change.

**Compile errors are always cached.** The request proposed a `cacheErrors` option. Both mokei
copies always cache, and with the option off a broken schema would be recompiled on every call
while still counting toward `maxCompiles`. The option is left out; adding it later does not
break anything.

**Lifecycle matches `createValidatorFactory`.** `clear()` resets the cache and leaves it usable.
`dispose()` resets it and makes later `get` calls throw. Both are idempotent.

**Input is `Schema` only**, as for the factory. A boolean schema (host-desktop compiles `false`)
still needs a cast at the call site, as it does today.

**The key comes from `canonicalizeJSON`, not `canonicalize`.** `canonicalize` follows
`JSON.stringify`: it honours `toJSON`, drops `undefined`, and can return `undefined`. A value typed
as `Schema` can therefore share a key with a schema that compiles differently. `canonicalizeJSON`
checks the value with `isJSONValue` first and throws a `TypeError` otherwise, so every key maps to
exactly one compiled shape.

**Schemas are self-contained; each compile starts from an empty registry.** AJV registers every
`$id` it meets, nested ones included, and keeps them after the compile. `compileValidator` only
removes the root `$id` after a successful compile. Two consequences, both reproduced: a failed
compile with `$id: "x"` makes every later compile of a schema with `$id: "x"` fail with "already
exists", and the cache would store that spurious error; two distinct schemas sharing a nested
`$id` cannot both compile on one factory. The shared, process-wide instances behind
`createValidator` have the same defect, and there it lasts for the life of the process. The fix
is in `compileValidator`, which both paths use, not in the cache: after every compile, success or
failure, call `ajv.removeSchema()` with no argument. That drops every non-meta schema and ref and
AJV's compile cache, and leaves meta-schemas, formats and validators already compiled working.
Neither path exposes its AJV instance (`getAjv` is module-private, the factory has no
`addSchema`), so no caller could rely on cross-schema `$ref`; the change makes that explicit.
`$ref` to a location inside the same schema is unaffected. Dropping AJV's compile cache costs
nothing: both paths memoize validators per schema object themselves.

## API

New file `packages/schema/src/cache.ts`, exported from `src/index.ts`:

```ts
export type ValidatorCacheOptions = {
  /** Options for each factory the cache creates. Default factory options if omitted. */
  factory?: ValidatorFactoryOptions
  /** Distinct compiles on one factory before it is disposed and replaced. Default 256. */
  maxCompiles?: number
  /** Validators (and cached compile errors) kept, least recently used evicted first. Default 64. */
  maxEntries?: number
}

export type ValidatorCacheStats = {
  /** Number of times the factory was replaced since creation or the last `clear()`. */
  generation: number
  /** Compiles on the current factory, failed compiles included. */
  compiles: number
  /** Entries currently in the LRU. */
  entries: number
}

export type ValidatorCache = {
  get: <S extends Schema, T = FromSchema<S>>(schema: S) => Validator<T>
  stats: () => ValidatorCacheStats
  clear: () => void
  dispose: () => void
}

export function createValidatorCache(options?: ValidatorCacheOptions): ValidatorCache
```

`get` has the same generic signature as `ValidatorFactory.createValidator`, so a literal schema
still infers its type.

`packages/schema/package.json` adds `"@sozai/json": "workspace:^"` to `dependencies`.

## Behaviour

**Construction.** `maxCompiles` and `maxEntries` must be integers of at least 1; otherwise
`createValidatorCache` throws a `RangeError` naming the option. No factory is created.

**`get(schema)`:**

1. If the cache is disposed, throw `Error('Validator cache is disposed')`.
2. Compute the key with `canonicalizeJSON(schema)`. A value that is not plain JSON makes it throw a
   `TypeError`; nothing is cached or counted.
3. **Hit.** Delete and re-insert the key, moving it to the most recent position. If the entry is
   an `Error`, throw it; otherwise return the validator. A hit never recycles the factory.
4. **Miss.**
   1. If a factory exists and `compiles >= maxCompiles`, recycle: call `dispose()` on the
      factory, drop the reference, clear the LRU, set `compiles` to 0 and increment `generation`.
   2. If no factory exists, create one with `createValidatorFactory(options.factory)`. The
      factory is therefore created on the first miss, never at construction.
   3. Compile with `factory.createValidator(schema)` inside `try/catch`. A thrown `Error` becomes
      the entry; any other thrown value is wrapped as `new Error(String(value))`. `compiles`
      increments whether the compile succeeded or failed, since AJV can grow its scope on a
      failed compile too.
   4. Insert the entry. If the LRU size now exceeds `maxEntries`, delete its first key.
   5. Throw the entry if it is an `Error`, else return it.

A cached error is rethrown as the same `Error` object on every hit.

**`stats()`** returns `{ generation, compiles, entries }` as a new object.

**`clear()`** calls `dispose()` on the current factory if one exists, drops the reference, clears
the LRU and sets `generation` and `compiles` to 0. The cache stays usable; the next miss creates
a new factory.

**`dispose()`** runs `clear()`, then marks the cache disposed. Disposal is terminal: a second
`dispose()` does nothing, `clear()` after `dispose()` does nothing, and `get` keeps throwing.

**Validators outlive recycling.** The cache holds a reference only to the current factory. A
validator handed out before its factory was disposed keeps validating, and keeps that AJV
instance alive until the validator itself is collected.

## Change to `compileValidator`

In `packages/schema/src/validation.ts`, `compileValidator` wraps `ajv.compile(schema)` in
`try/finally` and calls `ajv.removeSchema()` (no argument) in the `finally`, replacing the current
guarded `removeSchema(schema.$id)` after a successful compile. The comment above it changes to
say why: every compile starts from an empty registry, so a failed compile or a nested `$id` cannot
block a later schema. This applies to both `createValidator` (shared instances) and
`createValidatorFactory`. It is a bug fix released in the same minor as the cache.

## Documentation

- `packages/schema/README.md`: correct the `createValidatorFactory` paragraph, which says
  `dispose()` releases every compiled validator; validators already returned keep working and keep
  the instance alive. Then add a short example of `createValidatorCache`, the self-contained-schema
  rule, and the consumer guidance below.
- `plugins/sozai/skills/validation/reference/schema.md`: add `createValidatorCache`,
  `ValidatorCache`, `ValidatorCacheOptions` and `ValidatorCacheStats` to the exports table.
  Replace the hand-written recycling example under "Runtime schemas" with the cache.
- `plugins/sozai/skills/validation/SKILL.md`: the closing note says nothing in the repo depends
  on `@sozai/schema` or `@sozai/json` besides `codec`, which is already stale. Rewrite it: `codec`,
  `flow-graph` and `schema` depend on `@sozai/json`; `flow`, `flow-graph` and `patch` depend on
  `@sozai/schema`.
- A `pnpm change` entry: minor for `@sozai/schema`, naming both the cache and the `$id` fix.

Consumer guidance, for the README and the reference:

> Look a validator up at the moment of use, and do not hold it longer than needed. A long-lived
> holder, such as a suspended run keeping a validator, keeps its disposed AJV instance alive.

## Tests

New file `packages/schema/test/cache.test.ts`. Small bounds (for example `maxCompiles: 3`,
`maxEntries: 2`) keep the tests short. Fixtures must type-check against `Schema`: the compile-error
fixture is `{ type: 'string', pattern: '(' }` (an invalid regular expression); a draft 2020-12
keyword such as `prefixItems` needs a cast, since `Schema` is the draft-07 type.

Ported from mokei:

- identical and key-reordered schemas return the same validator, with `compiles: 1`;
- schemas that differ only in array order (for example `required`) are distinct entries;
- the first miss after `maxCompiles` distinct compiles increments `generation` and leaves
  `{ compiles: 1, entries: 1 }`;
- a validator obtained before recycling still validates, both accepting and rejecting;
- the LRU holds at most `maxEntries` and evicts the least recently used entry: after a hit on
  the oldest-inserted entry, a new miss evicts the other one;
- a failed compile counts once, is cached, and is rethrown as the
  same `Error` on the next `get` with an equal schema, without a second compile.

New:

- `stats()` is `{ generation: 0, compiles: 0, entries: 0 }` before the first `get`;
- a hit on a full factory (`compiles === maxCompiles`) does not recycle;
- `factory` options are passed through: with `{ draft: '2020-12' }`, a schema using
  `prefixItems` validates as 2020-12;
- `clear()` resets all stats to zero and the next `get` compiles again;
- after `dispose()`, `get` throws `Validator cache is disposed`; a second `dispose()` and a
  `clear()` do not throw, and `get` still throws;
- a value that is not plain JSON (an object with a `toJSON` method) throws `TypeError`, and
  `stats()` is unchanged;
- a literal schema passed to `get` infers its type (type test, `expectTypeOf`).

- `maxCompiles: 0`, `maxEntries: 0` and a non-integer bound each throw `RangeError`.

In `packages/schema/test/lib.test.ts`, for the `compileValidator` change, each case run through
both `createValidator` and `createValidatorFactory` (fixture `$id`s unique per test, since the
shared instances live for the whole test file):

- after a failed compile of a schema with `$id: 'x'`, a valid schema with `$id: 'x'` compiles;
- two distinct schemas with the same nested `$id` both compile, and each validator checks its own
  shape;
- a schema with an internal `$ref` to its own `definitions` still compiles and validates;
- a validator compiled before a later compile still validates, both accepting and rejecting.

## Out of scope

- A validator-factory option in `FlowGraphOptions` for `@sozai/flow-graph`, so the graph's own
  compiles can use a recycled cache. Separate request.
- Replacing the two mokei implementations. mokei does this once the release is published.

## Then

Once published, mokei replaces `src/validators.ts` in `@mokei/decision-flow-server` and the
validator cache in `@mokei/host-desktop`'s `src/form.ts` with `createValidatorCache`.
host-desktop passes `{ factory: { draft: '2020-12', strict: false } }`.
