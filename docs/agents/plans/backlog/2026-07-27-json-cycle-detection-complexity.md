# json — cycle detection is O(depth) per node

**Status:** open · low priority (no known workload where it matters)
**Package:** `@sozai/json`
**Context:** [completed/2026-07-27-json-package](../completed/2026-07-27-json-package.complete.md)

`canonicalize` tracks ancestors in an array and tests membership with `Array.prototype.includes`,
so each visited node scans the whole ancestor chain. That makes canonicalization O(d²) in nesting
depth, where the earlier implementation used a `Set` and was O(1) per check.

The array came in with the independent rewrite of the serializer, alongside `push`/`pop` in a
`finally` block, which is what made the cycle gate uniform across every object reference — the
previous version had two separate gates and skipped one for boxed primitives. The structure is
better; only the membership test regressed.

## Why it was parked

`canonicalize` has no depth limit of its own — stack exhaustion bounds recursion first, and V8
blows the stack somewhere around 10⁴ frames. Worst case is therefore a few million extra reference
comparisons on a payload that is already pathological, and every realistic signing payload is
shallow. Raised by the final whole-branch review as a Minor and deliberately deferred rather than
fixed in the review's single fix wave.

## Fix

Maintain a `Set` alongside the ancestor array — the array preserves the ordered push/pop discipline
that made the gate uniform, the `Set` restores O(1) membership. Add and delete in the same places
the array is pushed and popped.

Worth doing if a profile ever shows it, or opportunistically when that function is next touched.
Not worth a dedicated change on its own.
