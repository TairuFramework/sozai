# patch — atomic-swap prototype hardening (own `__proto__` round-trip)

**Status:** complete
**Date:** 2026-07-24
**Packages:** `@sozai/patch` (patch — bugfix)
**Source:** the last remaining item of [backlog/2026-07-03-patch-followups](../backlog/) (now removed
— the docs/coverage/RFC half landed [earlier the same day](2026-07-24-patch-followups-docs-coverage.complete.md)).
Originally the deferred "atomic swap prototype hardening" minor from the RFC 6902 compliance work.

## Reassessment that reversed the deferral

The backlog framed this as theoretical. Verified empirically, it is a **real, reproducible
correctness bug**, which is why the earlier "leave it" call was reversed:

- `JSON.parse('{"__proto__":{…},"a":1}')` produces an **own** `"__proto__"` data property (it does
  not invoke the accessor), and `structuredClone` preserves it.
- The atomic swap ended with `Object.assign(data, working)`. `Object.assign`'s `[[Set]]` triggers the
  `__proto__` accessor, so the member was **silently dropped** and `data`'s **own prototype was
  reassigned** to its value — even with no patch referencing it.
- Bounded to `data`: the global `Object.prototype` is never reachable (the injected value came from
  `data` itself). Not global pollution — instance-level data loss + surprise prototype mutation.

It is also consistent with the package's existing posture: `parsePath`'s `FORBIDDEN_SEGMENTS` already
rejects `__proto__`/`constructor`/`prototype` in patch *paths*; the swap was the one place the guard
was not applied.

## What was built

- **`apply.ts`:** the swap's re-add loop now uses `Object.defineProperty`
  (`[[DefineOwnProperty]]`) per key instead of `Object.assign` (`[[Set]]`), so an own `"__proto__"`
  key is written as a plain data property. The clear loop is unchanged (`delete` removes the own key
  without touching the accessor). No behavior change for documents without a `__proto__` member —
  `defineProperty` with a plain data descriptor is observationally identical to assignment for JSON.
- **`lib.test.ts`:** a `prototype safety` test round-trips a `__proto__`-bearing document through an
  unrelated `replace` and asserts the member survives as an own key, `data`'s prototype stays
  `Object.prototype`, and the global prototype is clean.
- **Changeset** (`patch-proto-roundtrip.md`, patch).

## Verification

- `@sozai/patch` vitest 142/142 green (+1), `tsc --noEmit` clean, biome clean.
- Mutation-sanity: reverting the re-add loop to `Object.assign(data, working)` fails exactly the new
  prototype-safety test; the other 141 stay green, so no existing test silently depended on the old
  swap.
