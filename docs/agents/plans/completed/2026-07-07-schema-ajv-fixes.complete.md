# schema — Ajv instance fixes

**Status:** complete
**Date:** 2026-07-07
**Branch:** fix/schema-ajv-fixes
**Source:** [audit 2026-07-02 — schema](2026-07-02-repo-audit.complete.md#schema) · roadmap freeze-blocker #2

## Goal

Fix the five audited defects in `@sozai/schema` in a single PR, before the API freeze.
Ajv instances are cached per `(draft, strict)` and shared across every `createValidator`
caller, so a single-caller bug has global blast radius — and RPC validation sits directly on
this layer.

## What was built

Five fixes across `packages/schema/src/{validation,errors,utils}.ts`, each TDD, per-task
reviewed, plus a final whole-branch review (READY TO MERGE, no Critical/Important):

1. **`removeSchema` `$id` guard (critical).** `createValidator` called
   `ajv.removeSchema(schema.$id)` after compiling; when `$id` was `undefined`,
   `removeSchema(undefined)` wiped *all* schemas/refs/compile-cache on the shared instance.
   Now guarded with `if (schema.$id != null)`. An `$id`-less schema registers nothing, so
   skipping the removal leaks nothing.

2. **Validator memoization (performance).** Module-level
   `WeakMap<Schema, Map<string, Validator>>` keyed by schema object then by normalized
   `${draft}:${strict}`. Cache hit returns a stable validator reference and skips Ajv codegen.
   The memo key is provably 1:1 with the `getAjv` instance key (both normalize `undefined`→
   `'default'`), so no cross-map poisoning. Incidentally fixes a latent pre-branch bug: a
   second `createValidator` on the same schema object carrying a nested `$id` used to throw
   "already exists" on recompile.

3. **JSON Pointer unescaping (correctness).** New `unescapePointer` helper (RFC 6901:
   `~1`→`/` then `~0`→`~`). `ValidationErrorObject` now decodes each `instancePath` segment,
   so error `path` arrays are correct for keys containing `/` or `~`.

4. **Own-property ref traversal (correctness / security).** Replaced the over-broad
   `BLOCKED_SEGMENTS` blocklist in `resolveReference` with an `Object.hasOwn` per-hop guard,
   and decode each `$ref` segment via `decodeURIComponent` then `unescapePointer`. Legitimate
   own properties (e.g. `toString`) now resolve; inherited `__proto__`/`constructor`/
   `prototype` are still rejected (read-only traversal, no pollution vector). Fixes
   `#/$defs/a~1b` (escaped slash) and percent-encoded segments.

5. **`any`→`unknown` (convention).** `resolveReference`'s traversal cursor is now `unknown`,
   removing the biome suppression.

## Key design decisions

- **Decode-site asymmetry is deliberate.** `errors.ts` tilde-unescapes only (Ajv
  `instancePath` is a raw JSON Pointer, *not* URI-encoded — adding `decodeURIComponent` there
  would corrupt keys with literal `%`). `utils.ts` does percent-decode *then* tilde-unescape
  (a `$ref` fragment is a URI JSON Pointer).
- **Prototype-pollution defense via `Object.hasOwn`, not a blocklist.** Traversal is
  read-only; own-property-only lookups reject inherited names without false-positives on
  legitimate own keys.
- **Memoization keys by schema-object identity.** A schema mutated in place after its first
  `createValidator` call keeps returning the original validator; schemas are expected to be
  immutable (`as const`) literals. Documented in code.
- **Malformed percent-escapes fail closed with the traversal's own error.**
  `decodeURIComponent` on a lone `%` throws a raw `URIError`; wrapped so it surfaces as
  `Invalid reference segment`.

## Public API

Unchanged. `createValidator`, `createStandardValidator`, `resolveReference`, `resolveSchema`,
`ValidationError`, `ValidationErrorObject` keep their signatures. `unescapePointer` added as a
new export. The only behavioral additions: validator reference-stability (memoization) and a
missing-own-key `$ref` now throwing `Invalid reference segment` instead of `Reference not
found` (the latter now fires only for own keys resolving to `null`/`undefined`).

## Verification

45/45 unit tests (2 files), `tsc --noEmit -p tsconfig.test.json` clean, `tsc
--emitDeclarationOnly` clean, `biome check` clean. New tests cover: the shared-instance
`removeSchema` regression, memoization reference identity, JSON Pointer decode in error paths
and `$ref` resolution, own-property traversal (positive + prototype-pollution rejection), and
malformed-`%` handling.

## Notes

- The audit's nested-`$id` cross-object collision concern was investigated and found
  **not reproducible** in Ajv 8.20.0: nested `$id`s (referenced by pointer or by `$id`) do not
  register globally, so they cannot collide; only top-level `$id` collides, and that path is
  covered by fix 1's guard.
- Follows the audit's freeze-blocker sequence; next in line is lifecycle-pass (freeze-blocker
  #3) in `next/`.
