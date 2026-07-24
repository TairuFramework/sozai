# patch — deferred follow-ups: docs, coverage, and the RFC move-identical-path fix

**Status:** complete
**Date:** 2026-07-24
**Packages:** `@sozai/patch` (patch — behavior change in `move`)
**Source:** [backlog/2026-07-03-patch-followups](../backlog/2026-07-03-patch-followups.md), the deferred
minors from [2026-07-03-patch-rfc6902-compliance](2026-07-03-patch-rfc6902-compliance.complete.md).

Took the docs/coverage half plus one correctness-adjacent RFC fix. The theoretical atomic-swap
prototype-hardening item was deliberately left (remains in the backlog file).

## What was done

- **`move` with identical `from` and `path` is now a permitted no-op (behavior change).**
  `isProperPrefix` returned `true` for `from === path`, so `move /a → /a` threw `INVALID_PATH`. RFC
  6902 §4.4 forbids only a *proper* prefix (move-into-descendant); an identical location is a
  permitted no-op. Dropped the `path === from` clause — which also makes the function name accurate —
  and added a comment citing the RFC. `move` into an actual descendant (`/a → /a/b`) still throws.
  Requires a changeset (`.changeset/patch-move-identical-path.md`, patch).
- **`parsePath` JSDoc `@throws` completed (docs).** It documented only the non-`/` case; it also
  throws on forbidden segments (`__proto__`/`constructor`/`prototype`). Added that, and noted the
  empty-string whole-document path is a non-throw returning `[]`.
- **Coverage: 3+-level missing-parent non-strict `remove`.** No test hit `deletePath`'s reduce-time
  undefined-guard (the existing `/foo/nope/bar` case surfaces `undefined` only on the last reduce
  step, caught post-reduce). Added `/foo/a/b/c`, where the parent vanishes two keys before the leaf,
  so `undefined` surfaces mid-reduce and exercises the reduce-time guard.

## Decided, no change

- **Atomic-swap prototype hardening — left.** Theoretical, touches the well-tested swap; stays in the
  backlog with a concrete-reason gate.
- **`apply.test.ts` `PATH_EXISTS` enumeration — kept.** No `PATH_EXISTS` code constant exists to
  retire; the "all error codes" test only asserts `PatchError` stores whatever code string it is
  given, so the dead entry is harmless.
- **Item 6 (`move` non-strict missing-`from` forward to `deletePath`) — already covered.** A missing
  `from` takes the early `break` before the forwarded `deletePath` (`lib.test.ts`: "non-strict move
  with missing from…"), and the forward on a present `from` is covered by the successful deep-move
  tests. No gap to fill.

## Verification

- `@sozai/patch` vitest 141/141 green (+2), `tsc --noEmit` clean, biome clean.
- Mutation-sanity, both new tests: restoring the `path === from` clause fails exactly the
  move-identical-path test; stripping `deletePath`'s reduce-time guard fails exactly the 3+-level
  remove test (with a `TypeError` from `undefined[key]`). Neither passes incidentally.
