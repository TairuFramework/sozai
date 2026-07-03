# @sozai/patch — deferred follow-ups

**Status:** open · backlog · no freeze dependency
**Source:** deferred minors from [completed/2026-07-03-patch-rfc6902-compliance](../completed/2026-07-03-patch-rfc6902-compliance.complete.md)
(final whole-branch review). All non-blocking; the branch shipped RFC/Hybrid-correct without them.

## Correctness-adjacent

- **Atomic swap prototype hardening.** `applyPatches`' clone-and-swap ends with
  `Object.assign(data, working)`. If `data` carried an own `"__proto__"` key (e.g. from
  `JSON.parse` of untrusted input at a higher layer), `structuredClone` preserves it and
  `Object.assign`'s `[[Set]]` could reassign `data`'s own `[[Prototype]]`. Bounded to the
  caller's `data` object (NOT global `Object.prototype`), and the value originates from `data`
  itself — theoretical. Left untouched deliberately to avoid risking the well-tested atomic
  swap. Fix if desired: rebuild via `Reflect.ownKeys` + `Object.defineProperty` (uses
  `[[DefineOwnProperty]]`, not `[[Set]]`), which also round-trips such keys correctly.
- **`isProperPrefix` rejects `from === path`.** `move` from `/a` to `/a` throws `INVALID_PATH`;
  RFC 6902 forbids only a *proper* (strictly shorter) prefix, so an identical from/path is a
  permitted no-op. Current behavior is over-strict but safer. Relax to
  `path.startsWith(\`${from}/\`)` if strict RFC conformance is wanted, or document as intentional.

## Docs / hygiene

- `parsePath` JSDoc `@throws` is slightly incomplete about the `''` (whole-document) exception —
  already partly addressed in the cleanup commit; verify wording.
- `test/apply.test.ts` "all error codes" enumerates `PATH_EXISTS`, which no op produces anymore
  (`add` no longer throws it after dropping `assertPathDoesNotExist`). The spec deliberately
  retains the code in the error set, so the enumeration is harmless — drop it only if the code
  constant is also retired.

## Coverage

- No test exercises a 3+ level missing-parent non-strict `remove` (e.g. `/foo/a/b/c`), the case
  that specifically requires `deletePath`'s reduce-time undefined-guard (vs. only the post-reduce
  guard). The code path is correct by inspection.
- `move`'s non-strict missing-`from` path takes an early `break` before its forwarded
  `deletePath(..., strict)`, so that specific forward is only indirectly exercised.
