# schema Ajv Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks
**Spec:** [2026-07-07-schema-ajv-fixes-design](../specs/2026-07-07-schema-ajv-fixes-design.md)

**Goal:** Fix five audited defects in `@sozai/schema` — a global-cache-corruption bug, missing memoization, JSON Pointer mishandling, an over-broad reference-traversal guard, and one `any` slip — in a single PR.

**Architecture:** All changes live in `packages/schema/src/{validation,errors,utils}.ts`. Ajv instances are cached per `(draft, strict)` and shared across callers, so the `removeSchema` guard is the highest-blast-radius fix and lands first. A new internal `unescapePointer` helper in `utils.ts` is shared by `errors.ts` (decoding Ajv `instancePath`) and `utils.ts` (decoding `$ref` fragments). Public signatures are unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Ajv + ajv-formats, Vitest, biome. Package `@sozai/schema`.

## Global Constraints

- `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES `#fields`, never `private`/`readonly`.
- Do not edit generated files (`lib/`).
- Import specifiers use `.js` extension (ESM).
- Public API surface unchanged: `createValidator`, `createStandardValidator`, `resolveReference`, `resolveSchema`, `ValidationError`, `ValidationErrorObject` keep their signatures.
- Run unit tests from repo root as `pnpm --filter @sozai/schema exec vitest run <path>` (avoids the local `rtk` shim that hijacks `pnpm run`).
- Run type tests as `pnpm --filter @sozai/schema exec tsc --noEmit -p tsconfig.test.json`.

---

### Task 1: `removeSchema` guard (critical)

Undefined `$id` makes `ajv.removeSchema(undefined)` wipe every schema/ref/compile-cache entry on the shared instance. Guard it. Land first — highest blast radius.

**Files:**
- Modify: `packages/schema/src/validation.ts:51`
- Test: `packages/schema/test/lib.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change; `createValidator` behavior only.

- [ ] **Step 1: Write the failing test**

Add inside `describe('createValidator()', ...)` in `packages/schema/test/lib.test.ts`:

```ts
test('a $id-less schema does not wipe the shared instance cache', () => {
  // Schema A registers a $id and an internal $ref on the shared (draft, strict) instance.
  const validateA = createValidator({
    $id: 'https://sozai.test/a',
    type: 'object',
    properties: { child: { $ref: '#/$defs/Child' } },
    $defs: { Child: { type: 'string' } },
    required: ['child'],
    additionalProperties: false,
  } as const)

  // Schema B has no $id — the buggy removeSchema(undefined) would clear A here.
  createValidator({ type: 'object', properties: { n: { type: 'number' } } } as const)

  // A must still validate correctly after B was created.
  expect(validateA({ child: 'ok' })).toEqual({ value: { child: 'ok' } })
  expect(validateA({ child: 1 })).toBeInstanceOf(ValidationError)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sozai/schema exec vitest run test/lib.test.ts -t 'does not wipe the shared instance'`
Expected: FAIL — A's `$ref` no longer resolves / throws after B clears the instance.

- [ ] **Step 3: Write minimal implementation**

In `packages/schema/src/validation.ts`, replace line 51:

```ts
  // Remove from AJV's internal cache. Guard the $id: removeSchema(undefined)
  // clears the ENTIRE shared instance (all schemas, refs, compile cache).
  if (schema.$id != null) {
    ajv.removeSchema(schema.$id)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sozai/schema exec vitest run test/lib.test.ts`
Expected: PASS (all existing + new).

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/validation.ts packages/schema/test/lib.test.ts
git commit -m "fix(schema): guard removeSchema against undefined \$id wiping shared instance"
```

---

### Task 2: Validator memoization (performance)

Every `createValidator` recompiles via Ajv codegen. Memoize per schema object + normalized options.

**Files:**
- Modify: `packages/schema/src/validation.ts:44-56`
- Test: `packages/schema/test/lib.test.ts`

**Interfaces:**
- Consumes: `Validator<T>` type, `getAjv`, the Task 1 guard.
- Produces: `createValidator` now returns a stable function reference for a repeated `(schema object, normalized options)`. No signature change.

- [ ] **Step 1: Write the failing test**

Add inside `describe('createValidator()', ...)`:

```ts
test('memoizes the validator per schema object and options', () => {
  const schema = { type: 'object', properties: { n: { type: 'number' } } } as const

  const a = createValidator(schema)
  const b = createValidator(schema)
  expect(a).toBe(b) // same schema object + default options => same function reference

  const c = createValidator(schema, { draft: '2020-12' })
  expect(c).not.toBe(a) // different options => distinct validator

  const d = createValidator(schema, { strict: undefined })
  expect(d).toBe(a) // strict:undefined collapses to the default cache entry

  // Distinct-but-equal schema objects do not share a cache entry.
  const other = { type: 'object', properties: { n: { type: 'number' } } } as const
  expect(createValidator(other)).not.toBe(a)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sozai/schema exec vitest run test/lib.test.ts -t 'memoizes the validator'`
Expected: FAIL — `a` and `b` are different function instances.

- [ ] **Step 3: Write minimal implementation**

In `packages/schema/src/validation.ts`, add a module-level cache after the `instances` map (near line 17):

```ts
// Memoize compiled validators per schema object, keyed by normalized options.
// WeakMap lets entries be collected when the schema object is.
const validators = new WeakMap<Schema, Map<string, Validator<unknown>>>()
```

Then rewrite the body of `createValidator` (lines 44-56) to check the cache before compiling:

```ts
export function createValidator<S extends Schema, T = FromSchema<S>>(
  schema: S,
  options?: ValidatorOptions,
): Validator<T> {
  const draft = options?.draft ?? '07'
  const strict = options?.strict ?? 'default'
  const cacheKey = `${draft}:${strict}`

  let byOptions = validators.get(schema)
  if (byOptions == null) {
    byOptions = new Map()
    validators.set(schema, byOptions)
  }
  const cached = byOptions.get(cacheKey)
  if (cached != null) {
    return cached as Validator<T>
  }

  const ajv = getAjv(draft, options?.strict)
  const check = ajv.compile(schema)
  // Remove from AJV's internal cache. Guard the $id: removeSchema(undefined)
  // clears the ENTIRE shared instance (all schemas, refs, compile cache).
  if (schema.$id != null) {
    ajv.removeSchema(schema.$id)
  }

  const validator: Validator<T> = (value: unknown) => {
    return check(value) ? { value: value as T } : new ValidationError(schema, value, check.errors)
  }
  byOptions.set(cacheKey, validator as Validator<unknown>)
  return validator
}
```

Note: `getAjv` still receives the raw `options?.strict` (so its own `?? 'default'` key logic is unchanged); only the memo key normalizes `undefined` to `'default'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sozai/schema exec vitest run test/lib.test.ts`
Expected: PASS (all existing + new). The Task 1 test still passes — the guard moved intact.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/validation.ts packages/schema/test/lib.test.ts
git commit -m "perf(schema): memoize compiled validators per schema and options"
```

---

### Task 3: JSON Pointer unescaping helper + error path decode

Add the shared `unescapePointer` helper and use it to decode Ajv `instancePath` segments in `ValidationErrorObject`.

**Files:**
- Modify: `packages/schema/src/utils.ts` (add + export `unescapePointer`)
- Modify: `packages/schema/src/errors.ts:16`
- Test: `packages/schema/test/lib.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function unescapePointer(segment: string): string` in `utils.ts` — replaces `~1`→`/` then `~0`→`~` (RFC 6901 order). Consumed by `errors.ts` and Task 4.

- [ ] **Step 1: Write the failing test**

Add a new describe block in `packages/schema/test/lib.test.ts`:

```ts
describe('ValidationErrorObject path decoding', () => {
  test('decodes JSON Pointer escapes in instancePath', () => {
    // Property name contains a slash and a tilde; Ajv encodes them as ~1 and ~0.
    const validator = createValidator({
      type: 'object',
      properties: { 'a/b~c': { type: 'number' } },
      required: ['a/b~c'],
    } as const)

    const result = validator({ 'a/b~c': 'not-a-number' })
    expect(result).toBeInstanceOf(ValidationError)
    const issue = (result as ValidationError).issues[0]
    expect(issue.path).toEqual(['a/b~c'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sozai/schema exec vitest run test/lib.test.ts -t 'decodes JSON Pointer escapes'`
Expected: FAIL — `path` is `['a~1b~0c']` (split fragments, undecoded).

- [ ] **Step 3: Write minimal implementation**

In `packages/schema/src/utils.ts`, add near the top (after the imports, before `resolveReference`):

```ts
/**
 * Decode a single JSON Pointer reference token (RFC 6901): `~1` -> `/`, `~0` -> `~`.
 * `~1` must be replaced before `~0`.
 */
export function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}
```

In `packages/schema/src/errors.ts`, add the import and update line 16:

```ts
import { unescapePointer } from './utils.js'
```

```ts
    this.#path = errorObject.instancePath
      .split('/')
      .filter((part) => part !== '')
      .map(unescapePointer)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sozai/schema exec vitest run test/lib.test.ts`
Expected: PASS (all existing + new).

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/utils.ts packages/schema/src/errors.ts packages/schema/test/lib.test.ts
git commit -m "fix(schema): decode JSON Pointer escapes in validation error paths"
```

---

### Task 4: Reference-traversal guard + `$ref` decode + `unknown`

Replace the over-broad `BLOCKED_SEGMENTS` blocklist with an own-property check, decode `$ref` fragment segments (percent + tilde), and drop the `any`.

**Files:**
- Modify: `packages/schema/src/utils.ts:3,10-25`
- Test: `packages/schema/test/lib.test.ts` (existing `resolveReference` suite) + `packages/schema/test/utils.test.ts` if present

**Interfaces:**
- Consumes: `unescapePointer` from Task 3.
- Produces: `resolveReference(root, ref)` — own-property-only traversal; legitimate own props (e.g. `toString`) resolve, inherited names are rejected with `Invalid reference segment`. Non-object mid-path still throws `Invalid reference path`.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('resolveReference()', ...)` suite in `packages/schema/test/lib.test.ts`:

```ts
test('resolves an own property named like an inherited method (toString)', () => {
  const schema = {
    type: 'object',
    properties: { toString: { type: 'string' } },
  } as unknown as Schema
  expect(resolveReference(schema, '#/properties/toString')).toEqual({ type: 'string' })
})

test('resolves a $ref with an escaped slash in the key (~1)', () => {
  const schema = {
    $defs: { 'a/b': { type: 'string' } },
  } as unknown as Schema
  expect(resolveReference(schema, '#/$defs/a~1b')).toEqual({ type: 'string' })
})

test('resolves a $ref with a percent-encoded segment', () => {
  const schema = {
    $defs: { 'a b': { type: 'string' } },
  } as unknown as Schema
  expect(resolveReference(schema, '#/$defs/a%20b')).toEqual({ type: 'string' })
})
```

Note the existing tests `rejects toString segment` / `rejects valueOf segment` (in `lib.test.ts`) stay valid: their `root` has no *own* `toString`/`valueOf`, so `Object.hasOwn` is false and they still throw `Invalid reference segment`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sozai/schema exec vitest run test/lib.test.ts -t 'resolveReference'`
Expected: FAIL — `toString` blocked by blocklist; `a~1b` / `a%20b` not decoded so keys not found.

- [ ] **Step 3: Write minimal implementation**

Rewrite `packages/schema/src/utils.ts` `resolveReference` (remove `BLOCKED_SEGMENTS` at line 3, replace the loop). Full function:

```ts
export function resolveReference(root: Schema, ref: string): Schema {
  if (!ref.startsWith('#')) {
    throw new Error(`Invalid reference format: ${ref}`)
  }

  const segments = ref.split('/').slice(1)
  let current: unknown = root
  for (const segment of segments) {
    const key = unescapePointer(decodeURIComponent(segment))
    if (current == null || typeof current !== 'object') {
      throw new Error(`Invalid reference path: ${ref}`)
    }
    if (!Object.hasOwn(current, key)) {
      throw new Error(`Invalid reference segment: ${key}`)
    }
    current = (current as Record<string, unknown>)[key]
    if (current == null) {
      throw new Error(`Reference not found: ${ref}`)
    }
  }
  return current as Schema
}
```

Delete the now-unused `const BLOCKED_SEGMENTS = ...` line and its `biome-ignore` comment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @sozai/schema exec vitest run test/lib.test.ts`
Then type-check (verifies the `any`→`unknown` change):
Run: `pnpm --filter @sozai/schema exec tsc --noEmit -p tsconfig.test.json`
Expected: both PASS. Existing `#/properties/name/maxLength/deep` test still throws `Invalid reference path` (non-object check runs before `hasOwn`).

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/utils.ts packages/schema/test/lib.test.ts
git commit -m "fix(schema): own-property ref traversal + decode \$ref pointer segments"
```

---

### Task 5: Full package verification

Confirm the whole package is green before review.

**Files:** none (verification only).

- [ ] **Step 1: Run the full package test suite**

Run: `pnpm --filter @sozai/schema exec vitest run`
Expected: all tests PASS.

- [ ] **Step 2: Run the type tests**

Run: `pnpm --filter @sozai/schema exec tsc --noEmit -p tsconfig.test.json`
Expected: no type errors.

- [ ] **Step 3: Lint the changed files**

Run: `pnpm exec biome check packages/schema/src`
Expected: no errors (no remaining `biome-ignore` needed in `utils.ts`).

- [ ] **Step 4: Build the package (declarations included)**

Run: `pnpm --filter @sozai/schema exec tsc --emitDeclarationOnly --skipLibCheck`
Expected: no errors.

---

## Self-Review

**Spec coverage:**
- Fix 1 removeSchema guard → Task 1. ✅
- Fix 2 memoization → Task 2. ✅
- Fix 3 JSON Pointer unescape (errors + refs) → Task 3 (helper + errors), Task 4 (refs). ✅
- Fix 4 traversal guard (`Object.hasOwn`) → Task 4. ✅
- Fix 5 `any`→`unknown` → Task 4. ✅
- Tests: removeSchema regression (Task 1), memoization (Task 2), JSON Pointer errors (Task 3), JSON Pointer refs + traversal (Task 4). ✅

**Placeholder scan:** none — every code step shows full code.

**Type consistency:** `unescapePointer(segment: string): string` defined in Task 3, consumed identically in Task 4 and `errors.ts`. `validators` WeakMap type matches `Validator<unknown>` cast in Task 2. Cache key format `${draft}:${strict}` consistent with `getAjv` key semantics.
