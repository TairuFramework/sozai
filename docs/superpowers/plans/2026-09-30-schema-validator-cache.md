# Schema Validator Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `createValidatorCache` to `@sozai/schema`, and make every AJV compile in the package leave the instance's registry as it found it.

**Architecture:** `validation.ts` pairs each AJV instance with a baseline set of registry keys and cleans up to that baseline after every compile, behind a reserved-`$id` guard; both memo paths skip non-object schemas. A new `cache.ts` holds a closure over a `Map` LRU keyed by `canonicalizeJSON`, compiling `JSON.parse(key)` snapshots on a lazily created factory that is recycled after `maxCompiles` compiles.

**Tech Stack:** TypeScript, AJV 8.20 (`Ajv`, `Ajv2020`, `ajv-formats`), `@sozai/json`, vitest, pnpm workspaces, turbo.

**Spec:** `docs/superpowers/specs/2026-09-30-schema-validator-cache-design.md`. Read it before any task; it holds the reasoning (AJV probes, why not a no-argument `removeSchema()`, why a snapshot).

## Global Constraints

- Package: `@sozai/schema`, minor bump from 0.1.3. New dependency `"@sozai/json": "workspace:^"`.
- Conventions: `/Users/paul/dev/yulsi/kigu/plugins/kigu/skills/conventions/SKILL.md`. British spelling in prose and comments (`memoise`, `normalise`), ` -- ` not em dashes, descriptive generic names in new code (`TSchema`, `TValue`), `JSON` not `Json` in identifiers.
- Reuse `canonicalizeJSON` and the `JSONValue` type from `@sozai/json`; do not hand-roll canonical JSON.
- Do not edit `lib/` (generated).
- Run repo scripts as `rtk proxy pnpm ...` (an `rtk` shim rewrites plain `pnpm run`).
- Tests import from `../src/index.js`. `@sozai/json` resolves to its built `lib/`; if missing, run `rtk proxy pnpm --filter @sozai/json build`.
- Commit after each task on branch `feat/schema-validator-cache`, message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Exact strings: `Validator cache is disposed`, `Schema $id <id> is reserved` (with the schema's `$id` as written), defaults `maxCompiles` 256 and `maxEntries` 64.

## Review Focus

1. Two distinct schemas with the same root `$id`, compiled one after the other, both compile with their own shape (worked before via root-`$id` removal; must still work). Test in Task 1.
2. After recycling, a schema cached in the previous generation is a miss and compiles once on the new factory. Test in Task 3.
3. A broken schema cached before recycling is compiled again once after it, then cached again. Test in Task 3.
4. `maxEntries: Infinity` (a caller wanting "unbounded") throws `RangeError`, since bounds must be integers. Test in Task 3.
5. host-desktop's factory options `{ draft: '2020-12', strict: false }` pass through: an unknown keyword compiles instead of throwing. Test in Task 3.

---

### Task 1: Registry cleanup and reserved `$id` guard in `compileValidator`

**Files:**
- Modify: `packages/schema/src/validation.ts` (`createAjv`, `getAjv`, `instances`, `compileValidator`, `createValidatorFactory`)
- Test: `packages/schema/test/lib.test.ts` (new `describe('compile registry cleanup', ...)`)

**Interfaces:**
- Consumes: nothing new.
- Produces (module-private, used by Task 2): `type AjvContext = { ajv: AjvInstance; baseline: ReadonlySet<string> }`; `createAjv(params: CreateAjvParams): AjvContext`; `instances: Map<string, AjvContext>`; `compileValidator<T>(context: AjvContext, schema: Schema): Validator<T>`. Public API unchanged.

- [ ] **Step 1: Write the failing tests**

Add a `describe('compile registry cleanup')` block using `describe.each` over two compiler makers, each returning a `compile(schema)` function bound to one AJV instance:
- `createValidator`: `(draft = '07') => (schema) => createValidator(schema, { draft })` (the shared instance for that draft);
- `createValidatorFactory`: `(draft = '07') => { const factory = createValidatorFactory({ draft }); return (schema) => factory.createValidator(schema) }`.

Each test calls its maker once and runs every compile of the case through that one `compile`, so two compiles always hit the same instance. Every `$id` includes the test and path name (for example `` `cleanup-failed-${pathName}` ``), since shared instances live for the whole file. Pass fresh fixture objects to each compile (both paths memoise by object).

Cases, with assertions:
- `failed compile does not block its $id`: compiling `{ $id: id, type: 'string', pattern: '(' }` throws; then `{ $id: id, type: 'string' }` compiles and `isType(v, 'a')` is `true`.
- `same root $id, different shapes`: `{ $id: id, type: 'string' }` then `{ $id: id, type: 'number' }`; first accepts `'a'`, second accepts `1` and rejects `'a'`.
- `same nested $id in distinct schemas`: `{ type: 'object', properties: { a: { $id: nid, type: 'string' } } }` and `{ type: 'object', properties: { b: { $id: nid, type: 'number' } } }` both compile; `{ a: 'x' }` / `{ a: 1 }` accept/reject on the first, `{ b: 1 }` / `{ b: 'x' }` on the second.
- `internal $ref to definitions`: `{ definitions: { n: { type: 'number' } }, $ref: '#/definitions/n' }` accepts `1`, rejects `'x'`.
- `recursive root $id`: `{ $id: id, type: 'object', properties: { child: { $ref: id } } }` accepts `{ child: { child: {} } }`, rejects `{ child: { child: 1 } }`.
- `meta-schema alias survives`: two successive compiles of `{ $schema: 'http://json-schema.org/schema', type: 'string' }` (fresh objects) both succeed; run for draft `'07'` and `'2020-12'`.
- `$dynamicRef on 2020-12`: compile `{ $id: id, $dynamicAnchor: 'node', type: 'object', properties: { child: { $dynamicRef: '#node' } } }` with draft `'2020-12'`, then a second distinct schema with another `$id`; both accept `{ child: {} }`. Pass fixtures inline (the generic parameter admits keywords outside the draft-07 `Schema` type); annotate `: Schema` only where the fixture is draft-07.
- `reserved $id`: for draft `'07'` ids `http://json-schema.org/draft-07/schema`, `...#`, `...#/`; for draft `'2020-12'` ids `https://json-schema.org/draft/2020-12/schema`, `https://json-schema.org/draft/2020-12/meta/core`, each bare, `#` and `#/`. `expect(() => compile({ $id, type: 'string' })).toThrow(`Schema $id ${$id} is reserved`)`, then a schema with `$schema` equal to the bare meta-schema id still compiles.
- `earlier validator keeps working`: compile A (`type: 'string'`), then B (`type: 'number'`); A still accepts `'a'` and rejects `1`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk proxy pnpm --filter @sozai/schema exec vitest run test/lib.test.ts -t "compile registry cleanup"`
Expected: FAIL on `failed compile does not block its $id`, `same nested $id`, and `reserved $id` (AJV's "already exists" instead of the reserved message); the others may pass already.

- [ ] **Step 3: Implement the baseline and cleanup in `validation.ts`**

- `createAjv` returns `AjvContext`; `baseline` is `new Set([...Object.keys(ajv.schemas), ...Object.keys(ajv.refs)])`, taken after `addFormats`.
- `instances` becomes `Map<string, AjvContext>`; `getAjv` returns `AjvContext`; the factory keeps an `AjvContext | null` (set to `null` on `dispose()`).
- `compileValidator(context, schema)`:
  1. If `schema` is an object with a string `$id` and `schema.$id.replace(/#\/?$/, '')` is in `context.baseline`, throw `new Error(`Schema $id ${schema.$id} is reserved`)`.
  2. `try { check = ajv.compile(schema) } finally { cleanup }`, where cleanup calls `ajv.removeSchema(schema)` only when `typeof schema === 'object'`, then `ajv.removeSchema(key)` for each key of `ajv.schemas` and `ajv.refs` not in `context.baseline` (collect keys first, then remove).
  3. Delete the old guarded `removeSchema(schema.$id)` block and its comment. Replace the comment with the spec's reason: a compile must not leave anything registered, so a failed compile or a nested `$id` cannot block a later schema; the baseline, not a no-argument `removeSchema()`, keeps AJV's meta-schema alias.

- [ ] **Step 4: Run the package tests**

Run: `rtk proxy pnpm --filter @sozai/schema test`
Expected: PASS, including all existing tests and `test:types`.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/validation.ts packages/schema/test/lib.test.ts
git commit -m "Leave the AJV registry as found after every schema compile"
```

---

### Task 2: Boolean schemas skip memoisation

**Files:**
- Modify: `packages/schema/src/validation.ts` (`createValidator`, factory `createValidator`)
- Test: `packages/schema/test/lib.test.ts` (add to `describe('compile registry cleanup')`)

**Interfaces:**
- Consumes: `compileValidator(context, schema)` from Task 1.
- Produces: `createValidator(false as unknown as Schema)` and `factory.createValidator(false as unknown as Schema)` return a validator instead of throwing. Task 3's cache relies on this for a `false` key.

- [ ] **Step 1: Write the failing tests**

- `boolean false schema` (both paths): `const schema = false as unknown as Schema`; the compile does not throw; the validator returns a `ValidationError` for `1`, `'a'` and `null`; a later compile of `{ type: 'string' }` on the same path still accepts `'a'`.
- `factory counts boolean compiles`: on one factory, two `createValidator(false as unknown as Schema)` calls leave `factory.compiled === 2`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk proxy pnpm --filter @sozai/schema exec vitest run test/lib.test.ts -t "boolean"`
Expected: FAIL with `Invalid value used as weak map key`.

- [ ] **Step 3: Skip the `WeakMap` for non-object schemas**

In both `createValidator` and the factory's `createValidator`: when `typeof schema !== 'object'`, compile and return without `get` or `set` on the `WeakMap` (the factory still increments `compiled`). Add a one-line comment: boolean schemas cannot key a `WeakMap` and are cheap to recompile.

- [ ] **Step 4: Run the package tests**

Run: `rtk proxy pnpm --filter @sozai/schema test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/validation.ts packages/schema/test/lib.test.ts
git commit -m "Accept boolean schemas in createValidator and the factory"
```

---

### Task 3: `createValidatorCache`, docs and change intent

**Files:**
- Create: `packages/schema/src/cache.ts`
- Modify: `packages/schema/src/index.ts` (exports), `packages/schema/package.json` (dependency)
- Create: `packages/schema/test/cache.test.ts`
- Modify: `packages/schema/README.md`, `plugins/sozai/skills/validation/reference/schema.md`, `plugins/sozai/skills/validation/SKILL.md`
- Create (via `pnpm change`): `.changeset/<generated>.md`

**Interfaces:**
- Consumes: `createValidatorFactory`, `ValidatorFactory`, `ValidatorFactoryOptions`, `Validator`, `Schema`, `FromSchema` from `@sozai/schema`'s own modules; `canonicalizeJSON`, `JSONValue` from `@sozai/json`; boolean support from Task 2.
- Produces (public, exported from `src/index.ts`): `createValidatorCache(options?: ValidatorCacheOptions): ValidatorCache` and the types `ValidatorCache`, `ValidatorCacheOptions`, `ValidatorCacheStats`, exactly as in the spec's API section.

- [ ] **Step 1: Add the dependency**

Add `"@sozai/json": "workspace:^"` to `dependencies` in `packages/schema/package.json` (alphabetical, before `@standard-schema/spec`), then run `rtk proxy pnpm install`.
Expected: lockfile updated, no other changes.

- [ ] **Step 2: Write the failing tests in `test/cache.test.ts`**

Each case states its bounds; where none is stated, use the defaults. Fixtures: `const str = { type: 'string' } as const`, `const num = { type: 'number' } as const`, `const bool = { type: 'boolean' } as const`, `const broken = { type: 'string', pattern: '(' } as const`.

- `starts empty`: `stats()` equals `{ generation: 0, compiles: 0, entries: 0 }`.
- `reuses one compile for equal schemas`: `get({ type: 'object', required: ['a'], properties: { a: { type: 'string' } } })` and the same schema with keys reordered return the same validator (`toBe`); `stats().compiles === 1`.
- `array order matters`: `required: ['a', 'b']` and `required: ['b', 'a']` give two entries, `compiles === 2`.
- `recycles after maxCompiles` (`maxCompiles: 3`, and the next two cases continue on this cache): `get(str)`, `get(num)`, `get(bool)`, then `get({ type: 'null' })` gives `{ generation: 1, compiles: 1, entries: 1 }`.
- `validators outlive recycling`: a validator for `str` obtained before recycling still accepts `'a'` and rejects `1` after.
- `previous generation is a miss` (Review Focus 2): after the recycle above, `get(str)` returns a validator that is not the old one (`not.toBe`) and `compiles` becomes 2.
- `hit on a full factory does not recycle` (`maxCompiles: 3`): `get(str)`, `get(num)`, `get(bool)`, then `get(str)` again: `generation === 0`, `compiles === 3`.
- `evicts least recently used` (`maxEntries: 2`, default `maxCompiles` so no recycle interferes): `get(str)`, `get(num)`, `get(str)` (hit), `get(bool)`: `entries === 2`; `get(str)` leaves `compiles` unchanged (hit), `get(num)` increments it (evicted).
- `caches compile errors`: `get(broken)` throws; `stats().compiles === 1`; a second `get({ ...broken })` throws the same object (catch both, `toBe`) and `compiles` stays 1.
- `broken schema after recycling` (Review Focus 3): with `maxCompiles: 1`, `get(broken)` throws, `get(str)` recycles, `get(broken)` throws an error that is not the first one and `stats()` is `{ generation: 2, compiles: 1, entries: 1 }`.
- `passes factory options`: with `{ factory: { draft: '2020-12' } }`, `get({ type: 'array', prefixItems: [{ type: 'number' }], items: false })` accepts `[1]`, rejects `[1, 2]`.
- `host-desktop options` (Review Focus 5): with `{ factory: { draft: '2020-12', strict: false } }`, `get({ type: 'object', unknownKeyword: true } as never)` does not throw.
- `boolean schema`: `get(false as unknown as Schema)` rejects `1`; a second call is a hit (`compiles === 1`).
- `clear resets`: after two `get`s, `clear()` gives all-zero stats; the next `get(str)` gives `compiles === 1`.
- `dispose is terminal`: after `dispose()`, `get(str)` throws `Validator cache is disposed`; `dispose()` and `clear()` do not throw; `get(str)` still throws.
- `rejects non-JSON schemas`: `get({ type: 'string', toJSON: () => ({ type: 'number' }) } as never)` and `get({ type: 'string', description: undefined } as never)` each throw `TypeError`; `stats()` stays all zero.
- `compiles a snapshot`: `const schema = { type: 'object', properties: { z: { type: 'string' }, a: { type: 'string' } } } as const`; `const result = get(schema)({ z: 1, a: 1 })` is a `ValidationError`; `result.schema` `toEqual(schema)` and `not.toBe(schema)`; `result.issues.map((i) => i.path.join('/'))` equals `['a', 'z']`.
- `mutated schema object`: `const schema: { type: string } = { type: 'string' }`; `get(schema as unknown as Schema)` accepts `'a'`; set `schema.type = 'number'`; `get(schema as unknown as Schema)` accepts `1` and rejects `'a'`.
- `infers the value type`: `expectTypeOf(cache.get(str)).toEqualTypeOf<Validator<string>>()`.
- `rejects invalid bounds` (Review Focus 4): `maxCompiles: 0`, `maxEntries: 0`, `maxCompiles: 1.5`, `maxEntries: Infinity` each throw `RangeError`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `rtk proxy pnpm --filter @sozai/schema exec vitest run test/cache.test.ts`
Expected: FAIL, `createValidatorCache` is not exported.

- [ ] **Step 4: Implement `cache.ts` and export it**

`createValidatorCache(options?: ValidatorCacheOptions): ValidatorCache` in `src/cache.ts`, following the spec's Behaviour section step by step: validate bounds first (`Number.isInteger(value) && value >= 1`, else `RangeError` naming the option); closure state `factory: ValidatorFactory | undefined`, `generation`, `compiles`, `disposed`, and `entries: Map<string, Validator<unknown> | Error>`; the miss compiles `factory.createValidator(JSON.parse(key) as Schema)`, wraps non-`Error` throws with `new Error(String(value))`, increments `compiles` in a `finally`, and evicts `entries.keys().next().value` when `entries.size > maxEntries`. `stats()` returns a new object. Add doc comments on each exported type and function, in the style of `createValidatorFactory`. Export the function and three types from `src/index.ts` next to the factory exports.

- [ ] **Step 5: Run the package tests**

Run: `rtk proxy pnpm --filter @sozai/schema test`
Expected: PASS (unit and types).

- [ ] **Step 6: Update the docs**

Per the spec's Documentation section:
- `packages/schema/README.md`: fix the factory paragraph (validators already returned keep working and keep the instance alive); add a short `createValidatorCache` example; state the self-contained-schema rule, the snapshot notes (`ValidationError.schema` is the snapshot; issues follow sorted key order), the reserved-`$id` rule, boolean schemas accepted when cast, and the consumer guidance quote.
- `reference/schema.md`: add `createValidatorCache`, `ValidatorCache`, `ValidatorCacheOptions`, `ValidatorCacheStats` to the exports table; replace the hand-written recycling example under "Runtime schemas" with the cache; add the same notes.
- `SKILL.md`: rewrite the closing note: `codec`, `flow-graph` and `schema` depend on `@sozai/json`; `flow`, `flow-graph` and `patch` depend on `@sozai/schema`.

- [ ] **Step 7: Record the change intent**

Run: `rtk proxy pnpm change @sozai/schema --bump minor --summary "<summary>"` with a summary listing: `createValidatorCache`, a bounded LRU of validators over recycled isolated factories; a failed compile or a nested `$id` no longer blocks a later schema with the same `$id` (`createValidator` and `createValidatorFactory`); a root `$id` equal to a meta-schema id throws `Schema $id <id> is reserved` instead of AJV's "already exists"; boolean schemas no longer throw `Invalid value used as weak map key`.
Expected: a new `.changeset/*.md` with `"@sozai/schema": minor`.

- [ ] **Step 8: Run the full checks**

Run: `rtk proxy pnpm run lint` and `rtk proxy pnpm run test` from the repo root (the pre-commit hook also runs `test:types` and the skills check).
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/schema pnpm-lock.yaml plugins/sozai/skills/validation .changeset
git commit -m "Add createValidatorCache to @sozai/schema"
```

---

### After the tasks

Move the spec's status line to complete and, per the repo convention, add a completion record under `docs/agents/plans/completed/2026-09-30-schema-validator-cache.complete.md` summarising what shipped (see `2026-09-30-schema-validator-factory.complete.md` for the shape). Commit with the last task or separately.
