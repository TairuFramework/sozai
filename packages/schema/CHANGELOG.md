# @sozai/schema

## 0.1.1

### Patch Changes

- 29345c8: Fix Ajv instance bugs found in the 2026-07-02 audit:

  - Guard `removeSchema` against an undefined `$id`, which previously wiped every schema, ref, and compile-cache entry on the shared per-`(draft, strict)` Ajv instance.
  - Memoize compiled validators per schema object and options (skips redundant Ajv codegen; also fixes a latent nested-`$id` recompile error).
  - Decode JSON Pointer escapes (`~0`/`~1`) in validation error `path` arrays.
  - Resolve `$ref` traversal via an `Object.hasOwn` own-property guard (rejects prototype-pollution segments while allowing legitimate keys like `toString`), with `~0`/`~1` and percent decoding of `$ref` segments.
