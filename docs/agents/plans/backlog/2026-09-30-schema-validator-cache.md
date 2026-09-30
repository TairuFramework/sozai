# schema — validator cache over isolated, recycled factories

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
  get: <T = unknown>(schema: Schema) => Validator<T>
  stats: () => ValidatorCacheStats
  clear: () => void
  dispose: () => void
}

export function createValidatorCache(options?: ValidatorCacheOptions): ValidatorCache
```

`packages/schema/package.json` adds `"@sozai/json": "workspace:^"` to `dependencies`.

## Behaviour

**Construction.** `maxCompiles` and `maxEntries` must be integers of at least 1; otherwise
`createValidatorCache` throws a `RangeError` naming the option. No factory is created.

**`get(schema)`:**

1. If the cache is disposed, throw `Error('Validator cache is disposed')`.
2. Compute the key: `canonicalize(schema) as string`. A `Schema` always serializes, so the key is
   never `undefined`.
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

**`dispose()`** runs `clear()`, then marks the cache disposed. A second call does nothing.

**Validators outlive recycling.** The cache holds a reference only to the current factory. A
validator handed out before its factory was disposed keeps validating, and keeps that AJV
instance alive until the validator itself is collected.

## Documentation

- `packages/schema/README.md`: after the `createValidatorFactory` paragraph, a short example of
  `createValidatorCache` and the consumer guidance below.
- `plugins/sozai/skills/validation/reference/schema.md`: add `createValidatorCache`,
  `ValidatorCache`, `ValidatorCacheOptions` and `ValidatorCacheStats` to the exports table.
  Replace the hand-written recycling example under "Runtime schemas" with the cache.
- `plugins/sozai/skills/validation/SKILL.md`: the closing note says nothing in the repo depends
  on `@sozai/json` besides `codec`; update it to name `schema` too.
- A `pnpm change` entry: minor for `@sozai/schema`.

Consumer guidance, for the README and the reference:

> Look a validator up at the moment of use, and do not hold it longer than needed. A long-lived
> holder, such as a suspended run keeping a validator, keeps its disposed AJV instance alive.

## Tests

New file `packages/schema/test/cache.test.ts`. Small bounds (for example `maxCompiles: 3`,
`maxEntries: 2`) keep the tests short.

Ported from mokei:

- identical and key-reordered schemas return the same validator, with `compiles: 1`;
- schemas that differ only in array order (for example `required`) are distinct entries;
- the first miss after `maxCompiles` distinct compiles increments `generation` and leaves
  `{ compiles: 1, entries: 1 }`;
- a validator obtained before recycling still validates, both accepting and rejecting;
- the LRU holds at most `maxEntries` and evicts the least recently used entry: after a hit on
  the oldest-inserted entry, a new miss evicts the other one;
- a failed compile (for example `{ type: 'nope' }`) counts once, is cached, and is rethrown as the
  same `Error` on the next `get` with an equal schema, without a second compile.

New:

- `stats()` is `{ generation: 0, compiles: 0, entries: 0 }` before the first `get`;
- a hit on a full factory (`compiles === maxCompiles`) does not recycle;
- `factory` options are passed through: with `{ draft: '2020-12' }`, a schema using
  `prefixItems` validates as 2020-12;
- `clear()` resets all stats to zero and the next `get` compiles again;
- after `dispose()`, `get` throws `Validator cache is disposed`, and a second `dispose()` does
  not throw;
- `maxCompiles: 0`, `maxEntries: 0` and a non-integer bound each throw `RangeError`.

## Out of scope

- A validator-factory option in `FlowGraphOptions` for `@sozai/flow-graph`, so the graph's own
  compiles can use a recycled cache. Separate request.
- Replacing the two mokei implementations. mokei does this once the release is published.

## Then

Once published, mokei replaces `src/validators.ts` in `@mokei/decision-flow-server` and the
validator cache in `@mokei/host-desktop`'s `src/form.ts` with `createValidatorCache`.
host-desktop passes `{ factory: { draft: '2020-12', strict: false } }`.
