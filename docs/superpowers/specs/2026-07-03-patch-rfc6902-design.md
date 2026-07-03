# @sozai/patch — RFC 6902 compliance + prototype-pollution fix

**Status:** draft — awaiting review
**Branch:** `patch-rfc6902-compliance`
**Plan item:** [next/patch-rfc6902-compliance](../../agents/plans/next/patch-rfc6902-compliance.md)
**Source audit:** [2026-07-02](../../agents/plans/completed/2026-07-02-repo-audit.complete.md#patch)

## Context

`@sozai/patch` is the canonical patch format for the stack; `applyPatches` runs on
untrusted remote input. The package is freshly split (only commit: "Setup"), has **no
in-repo consumers**, and external consumers can't be seen from here — so the contract can
still be fixed before it ossifies at freeze. The audit framed the work as "make it RFC 6902
compliant," but the code is deliberately a **superset**: it carries a non-standard `set` op
and a `strict`/non-strict mode, neither in RFC 6902.

## Decision — contract shape: **Hybrid**

The six RFC ops behave exactly per RFC 6902 / RFC 6901. `set` and non-strict survive as
**documented non-standard extensions**. Rationale: standard ops must interop (patches to/from
other JSON Patch tooling, predictable remote-input behavior); `set` and non-strict are useful
and cleanly separable, and `set` gets a clear identity once `add` becomes insert-semantics.

| Op | Semantics after this work |
|----|---------------------------|
| `add` | RFC: array index → **insert before**; `/-` → **append**; object key → assign (replace if present) |
| `remove` | RFC: target must exist (strict); array → splice |
| `replace` | RFC: target must exist (strict); assign in place |
| `copy` | RFC: **deep-clone** source, insert at dest with `add` semantics |
| `move` | RFC: assert `from` is not a proper prefix of `path`; remove from source, insert at dest |
| `test` | RFC: **deep structural JSON equality** |
| `set` | **Extension** — assign/overwrite at path; array index → overwrite; `/-` → append; upsert object keys. Never inserts. |

`strict` flag reinterpreted cleanly: **`strict: true` ≡ RFC semantics** (targets must exist
for replace/remove/move/copy-from/test). **`strict: false` ≡ lenient convenience** (missing
paths tolerated: `replace`≈`set`, `remove`≈no-op). `add` is RFC in **both** modes — the
current strict-mode `assertPathDoesNotExist` is dropped (RFC `add` may replace).

## Scope

### 1. Security (do first)

- **Prototype pollution** (`apply.ts` `parsePath`): reject any path segment equal to
  `__proto__`, `constructor`, or `prototype`, throwing `PatchError(..., 'INVALID_PATH')`.
  Guarding in `parsePath` covers every op (get/set/delete all route through it). Use
  `Object.hasOwn` for object existence checks instead of `in` / `key in target`. Align with
  `@sozai/schema`'s `src/utils.ts`, which already blocks these segments.

### 2. RFC 6901 pointer correctness

- **Index parsing** (`parsePath`): treat a segment as an array index only when it matches
  `/^(0|[1-9]\d*)$/`; otherwise keep it a string key. Reject leading zeros, whitespace,
  `1e2`, `0x10`, `1.5`. Whether a numeric-looking key is an index is resolved at use-site
  against the actual parent type (array vs object), not by `Number()` coercion.
- **`-` append token**: represent `-` as a distinct sentinel; `add`/`set` append when parent
  is an array, error otherwise.
- **Empty pointer `""`** (whole-document, RFC 6901): **read-only support**. `getPath('')`
  returns the root; the `test` op accepts `''` for whole-document deep-equality. Mutating ops
  (`add`/`replace`/`set`/`remove`) with path `''` throw a clear `PatchError` (e.g. "root
  replace unsupported") — the object-rooted in-place model can't reassign the caller's root
  reference, and a non-object root can't be represented. Better than the current generic
  `INVALID_PATH` throw, without a half-baked content-swap. Note: `''` (whole doc) is distinct
  from `'/'` (member with empty-string key).
- **Escaping already correct on parse** (`~1`→`/`, `~0`→`~`); the gap is on create (§4).

### 3. Array op correctness (`apply.ts`)

- `add` at array index → `splice(index, 0, value)` (insert before). `add /arr/-` → push.
- `set` at array index → overwrite; `set /arr/-` → push.
- Op-aware bounds: `remove`/`replace` at `index === length` must throw `INVALID_INDEX`, not
  silently no-op/append. Append (`index === length`) is valid only for `add`/`set`.
- `copy`: `structuredClone` the source value before insert (no shared live references).
- `move`: assert `from` is not a proper prefix of `path` (RFC); then remove-from-source +
  insert-at-dest.

### 4. `createPatches` correctness (`create.ts`)

- **Argument order stays `createPatches(to, from?)`** — deliberately *not* reversed. `from`
  is optional (defaults to `{}` = "diff from empty / create from scratch"); an optional
  parameter cannot precede a required one, so the mainstream `(from, to)` order is
  incompatible with the optional-`from` ergonomic. Document the intentional order in the
  JSDoc (with a note that it is reversed from typical diff APIs) so the audit's concern is
  addressed by clarity rather than a breaking swap.
- **Escape emitted keys**: `key.replace(/~/g, '~0').replace(/\//g, '~1')` when building
  pointers, so create→apply round-trips for keys containing `/` or `~`.
- **Object↔array type change**: emit a single `replace` whenever
  `Array.isArray(fromValue) !== Array.isArray(toValue)`, instead of member-wise ops that
  splice a shrinking array or emit numeric-keyed objects.
- **Minors**: use `Object.is` for the "changed?" check so `NaN` doesn't diff as always-changed;
  skip `undefined` target values (treat as key-absent — JSON has no `undefined`).

### 5. `applyPatches` atomicity

- All-or-nothing: apply the sequence to a `structuredClone` of `data`; on full success, swap
  the clone's contents back into the original object (clear own keys, `Object.assign`), so a
  mid-sequence throw leaves the input untouched. Keeps the current void/in-place signature.

## Non-goals

- No move to a functional (return-new) `applyPatches` signature — kept in-place for API
  stability; revisit post-freeze if desired.
- No new error codes; the existing `INVALID_PATH`/`INVALID_INDEX`/`PATH_NOT_FOUND`/
  `PATH_EXISTS`/`TEST_FAILED`/`INVALID_OPERATION` set stays.
- `runtime-expo` / other packages untouched — this is the patch batch only.

## Testing

Current tests **enshrine broken behavior** (member-wise type-change series, `Object.is` test,
loose index acceptance) and must be rewritten alongside the fixes (TDD). New coverage per the
audit's gap list:

- Security: `__proto__` / `constructor` / `prototype` paths rejected (add/set/copy/move/test).
- Pointer: malformed indices (`' '`, `01`, `1e2`, `0x10`, `1.5`), `-` token, empty pointer.
- Array: `add` as insert, `add /-` append, `set` overwrite, remove/replace at-length throws.
- Ref safety: `copy` produces an independent subtree; `move` prefix-of-path rejected.
- `test` on compound (object/array) values, equal and unequal.
- create: key escaping round-trip, object↔array type change, NaN/undefined handling.
- apply atomicity: mid-sequence failure leaves input unchanged.

## Decisions (resolved)

1. **Contract = Hybrid** — RFC-correct six ops + `set`/non-strict as documented extensions.
2. **`createPatches` argument order — keep `(to, from?)`.** Not reversed; `from` is optional
   (defaults to `{}`), which requires it to stay second. Documented as intentional in JSDoc.
3. **Empty-pointer — read-only.** `get`/`test` support `''`; mutating ops at root throw a
   clear `PatchError`.
