# @sozai/patch — RFC 6902 compliance + prototype-pollution fix

**Status:** complete
**Date:** 2026-07-03
**PR:** TairuFramework/sozai#1

Roadmap item 1 from the [2026-07-02 repo audit](2026-07-02-repo-audit.complete.md#patch).
Made `@sozai/patch`'s six standard ops RFC 6902 / RFC 6901-correct and closed a
remotely-reachable prototype-pollution hole, before the package's API freezes. `applyPatches`
runs on untrusted remote input; the package was freshly split with no in-repo consumers, so
the contract could still be fixed cleanly.

## Key decision — Hybrid contract

The audit framed the work as "make it RFC 6902 compliant," but the code was deliberately a
**superset** (a non-standard `set` op and a `strict`/non-strict mode). Rather than strip the
extensions or leave the standard ops non-conformant, we chose **Hybrid**:

- The six RFC ops (`add`/`remove`/`replace`/`copy`/`move`/`test`) follow RFC 6902/6901 exactly.
- `set` (assign/overwrite, **never inserts**) and non-strict mode survive as **documented
  non-standard extensions**. `set` gains a clean identity now that `add` inserts.
- `strict: true` ≡ RFC semantics (targets must exist for replace/remove/copy-from/move-from/
  test); `strict: false` ≡ lenient convenience (missing paths tolerated — remove/copy/move
  become no-ops, replace ≈ set). `add` is RFC in **both** modes (insert/replace, never asserts
  not-exist).

## What was built

- **Security:** `parsePath` rejects `__proto__`/`constructor`/`prototype` segments (guards
  every op, since all route through it); object existence via `Object.hasOwn`, not `in`.
- **Pointer/index:** only canonical integers (`/^(0|[1-9]\d*)$/`) parse as array indices; the
  `-` append sentinel; read-only whole-document pointer `''` (`get`/`test` read the root;
  mutating ops at `''` throw `'Root mutation unsupported'`, since the object-rooted in-place
  model can't reassign the caller's reference).
- **Array ops:** `add` splice-inserts (RFC), `set` overwrites; op-aware bounds — `remove`/
  `replace` reject `index === length`, only `add`/`set` append.
- **`test`:** deep structural JSON equality with SameValueZero leaves (`NaN`=`NaN`, `+0`=`-0`),
  replacing reference `Object.is`.
- **`copy`/`move`:** `copy` deep-clones the source (`structuredClone`, no shared live
  reference); `move` rejects a `from` that is a proper prefix of `path`.
- **Atomicity:** `applyPatches` applies to a `structuredClone` and swaps back on full success,
  so a mid-sequence throw leaves the input untouched. (Void/in-place signature kept.)
- **`create.ts`:** escape emitted keys (`~0`/`~1`) so create→apply round-trips; a single
  `replace` on object↔array type change; no spurious `replace` for equal `NaN`; drop
  `undefined` values. `createPatches(to, from?)` order kept intentionally (optional `from`
  diffs against `{}`), documented as reversed-from-typical rather than swapped.

## Design decisions worth preserving

- **`createPatches` argument order was NOT reversed.** The audit flagged `(to, from)` as
  backwards vs. mainstream diff APIs, but `from` is optional (defaults `{}` = diff-from-empty),
  and an optional param can't precede a required one. Kept `(to, from?)`, documented as
  deliberate.
- **`createPatches` is positional element-wise diffing, not LCS/insert-detection.** A middle
  insertion emits replace+replace+add, not a clean `add`. RFC insert-before is an *apply*-side
  capability (a hand-authored `add /arr/i` patch), not something `create` produces. The README
  example reflects this.
- **Atomic swap replaces all nested object identities on success** (consequence of
  clone-and-swap). Consumers doing reference-equality / WeakMap-keying on nested objects across
  `applyPatches` calls should know this.
- **`structuredClone` typed via a module-local `globalThis` cast**, not `declare global` — the
  latter leaked an ambient augmentation into the published `.d.ts` for this frozen-foundation
  package.

## Testing

`@sozai/patch`: **139/139 unit + type checks pass**, biome clean. Existing tests that enshrined
pre-RFC behavior were rewritten (strict `add`-must-not-exist, `+0/-0` distinction, root-pointer
throw, object↔array member-wise diffs). New `test/parse-path.test.ts` covers the security guard
and index parsing.

## Execution

Subagent-driven: 11 planned TDD tasks + 1 review-discovered correctness fix (non-strict
leniency — `remove`/`copy`/`move` weren't forwarding `strict`; an existing test passed only by
accident via shared mutable state) + 1 hygiene cleanup. Per-task spec+quality reviews; final
whole-branch review clean (no Critical/Important).

## Follow-ups

Non-blocking deferrals extracted to [backlog/patch-followups](../backlog/patch-followups.md).
