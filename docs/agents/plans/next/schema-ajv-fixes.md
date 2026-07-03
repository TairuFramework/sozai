# schema — Ajv instance fixes

**Status:** open · freeze-blocker · priority 2
**Source:** [audit 2026-07-02 — schema](../completed/2026-07-02-repo-audit.complete.md#schema)

Ajv instances are shared per `(draft, strict)` across all `createValidator` callers, so
single-caller bugs have global blast radius. RPC validation sits directly on this layer.

## Critical

- **`src/validation.ts:49` — `removeSchema(schema.$id)` with no `$id` wipes the entire
  shared Ajv instance.** Verified: `ajv.removeSchema(undefined)` clears all registered
  schemas, refs, and the compile cache. One `$id`-less schema silently breaks later `$ref`
  resolution and defeats caching globally. Fix: `if (schema.$id != null)` guard. One line,
  do first.

## Performance

- **`src/validation.ts:44-56` — no validator memoization.** Every `createValidator` call
  recompiles (Ajv codegen) even for the same schema object. Add a
  `WeakMap<Schema, Validator>` keyed per options.

## Correctness

- `src/errors.ts:16` — `instancePath.split('/')` without JSON Pointer unescaping: keys with
  `/` or `~` yield wrong `path` arrays in standard-schema issues.
- `src/utils.ts:14` — blocklist rejects legitimate properties (`#/properties/toString`);
  `Object.hasOwn` fixes both the false positive and prototype-chain leakage. Line 10:
  segments not `~0`/`~1`- or percent-decoded, so `#/$defs/a~1b` can't resolve.

## Convention

- `src/utils.ts:12` — `let current: any` (biome-suppressed); `unknown` + narrowing works.

## Test-coverage gaps

Cross-call `$id`/`$ref` interaction on the shared Ajv instance (the `removeSchema` bug).
