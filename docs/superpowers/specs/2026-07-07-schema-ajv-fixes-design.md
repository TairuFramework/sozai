# schema — Ajv instance fixes

**Status:** design approved
**Source:** [audit 2026-07-02 — schema](../../agents/plans/completed/2026-07-02-repo-audit.complete.md#schema) · [next/schema-ajv-fixes](../../agents/plans/next/schema-ajv-fixes.md)
**Roadmap:** freeze-blocker #2 (one PR)

## Problem

Ajv instances are cached per `(draft, strict)` and shared across every `createValidator`
caller, so a single-caller bug has global blast radius. RPC validation sits directly on this
layer. The 2026-07-02 audit found five defects in `packages/schema` spanning a
global-cache-corruption bug, missing memoization, JSON Pointer mishandling, an over-broad
reference-traversal guard, and one convention slip.

Scope: `packages/schema` only. One plan, one PR. Files touched:
`src/validation.ts`, `src/errors.ts`, `src/utils.ts`, plus tests.

## Fixes

### 1. `removeSchema` guard — critical — `src/validation.ts:51`

`createValidator` calls `ajv.removeSchema(schema.$id)` after compiling to keep the shared
instance clean. When `schema.$id` is `undefined`, `ajv.removeSchema(undefined)` clears **all**
registered schemas, refs, and the compile cache on the shared instance. One `$id`-less schema
silently breaks later `$ref` resolution and defeats caching for every other caller on the same
`(draft, strict)` pair.

Fix:

```ts
if (schema.$id != null) {
  ajv.removeSchema(schema.$id)
}
```

The guard stays even after memoization (fix 2) — it still prevents `$id` collisions when two
different schemas carrying the same `$id` compile on the shared instance.

### 2. Validator memoization — performance — `src/validation.ts:44-56`

Every `createValidator` call re-runs `ajv.compile` (Ajv codegen) even for the same schema
object and options. Add a module-level cache:

```ts
const validators = new WeakMap<Schema, Map<string, Validator<unknown>>>()
```

Inner map key = `` `${draft}:${strict}` `` (same shape as the `getAjv` key, minus the
`?? 'default'`/`?? '07'` normalization — normalize identically so `undefined` and the default
collapse to one entry). On a cache hit, return the stored validator and skip both
`ajv.compile` and `removeSchema`. `WeakMap` keyed by the schema object lets entries be
collected when the schema is.

**Observable semantics (intentional, documented):** the same schema object with the same
options returns an identical `Validator` function reference across calls. Different options on
the same schema, or a different schema object (even structurally equal), produce distinct
validators. This is a behavior addition, not a breaking change — no caller can currently rely
on getting a fresh function.

### 3. JSON Pointer unescaping — correctness — `src/errors.ts:16`, `src/utils.ts`

JSON Pointer segments escape `~` as `~0` and `/` as `~1` (RFC 6901). Neither call site
decodes, so any object key containing `/` or `~` yields wrong results.

Shared internal helper (add to `src/utils.ts`, export for `errors.ts`):

```ts
// ~1 must be replaced before ~0 (RFC 6901 order)
export function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}
```

- **`errors.ts:16`** — `errorObject.instancePath` is a JSON Pointer produced by Ajv, not
  URI-encoded. Split on `/`, drop empties, `unescapePointer` each segment:

  ```ts
  this.#path = errorObject.instancePath
    .split('/')
    .filter((part) => part !== '')
    .map(unescapePointer)
  ```

- **`utils.ts` (`resolveReference`)** — the `$ref` fragment after `#` is a JSON Pointer inside
  a URI fragment, so each segment is `decodeURIComponent`'d **then** `unescapePointer`'d. Fixes
  `#/$defs/a~1b` (which must resolve to key `a/b`) and percent-encoded segments.

### 4. Reference-traversal guard — correctness / security — `src/utils.ts:3,14`

`BLOCKED_SEGMENTS` rejects legitimate schema properties (e.g. `#/properties/toString`) while
trying to prevent prototype-pollution. Replace the blocklist with an own-property check.

- Delete `BLOCKED_SEGMENTS`.
- Guard each hop with `Object.hasOwn(current, segment)`; throw
  `Invalid reference segment: ${segment}` if false.

Own-property-only traversal means inherited `__proto__` / `constructor` / `prototype` resolve
to nothing (rejected), while legitimate own properties like `toString` resolve. Traversal is
read-only (no assignment), so there is no pollution vector even if a schema carries a literal
own `__proto__` key.

### 5. `any` → `unknown` — convention — `src/utils.ts:12`

Replace `let current: any` (biome-suppressed) with `let current: unknown = root`. The
`Object.hasOwn` guard plus a `typeof current === 'object' && current !== null` narrowing makes
`current[segment]` type-check without the suppression. Remove the `biome-ignore` comment.

## Reference-traversal shape after fixes

`resolveReference` loop, each segment:

1. `decodeURIComponent(segment)` then `unescapePointer` → the real key.
2. If `current == null || typeof current !== 'object'` → throw `Invalid reference path`.
3. If `!Object.hasOwn(current, key)` → throw `Invalid reference segment`.
4. `current = (current as Record<string, unknown>)[key]`.

Return `current as Schema`.

## Testing

New coverage; the audit flagged cross-call `$id`/`$ref` interaction as the key gap.

- **removeSchema regression (shared instance):** compile schema A carrying `$id` and a `$ref`,
  then compile a `$id`-less schema B on the same `(draft, strict)`; assert A's validator still
  resolves its `$ref` (would fail before the guard because B's `removeSchema(undefined)` wiped
  the instance).
- **Memoization:** `createValidator(schema)` twice → identical function reference; same schema
  with differing `options` → distinct references; `strict: undefined` and the default collapse
  to one cache entry.
- **JSON Pointer (errors):** validation failure on a key containing `/` and `~` → `path` array
  holds the decoded key, not the split fragments.
- **JSON Pointer (refs):** `$ref` `#/$defs/a~1b` resolves to the `a/b` key; a percent-encoded
  segment resolves.
- **Traversal guard:** `#/properties/toString` resolves when present as an own property;
  `#/__proto__`, `#/constructor`, `#/prototype` are rejected.

## Out of scope

Other freeze-blocker items (lifecycle, result, codec, stream, otel, log, infra) — each is its
own plan. No changes to the public `createValidator` / `createStandardValidator` signatures.
