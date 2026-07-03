# result — map/mapError error handling + predicate design

**Status:** open · freeze-blocker · priority 5 · has a decision gate
**Source:** [audit 2026-07-02 — result](../completed/2026-07-02-repo-audit.complete.md#result)

`Result`/`Option` sit under most error handling in the stack. Two correctness bugs plus one
type-design decision that is API-shaping (resolve before freeze).

## Correctness

- **`src/result.ts:105` — `mapError` turns a thrown non-Error into a success Result**
  (verified: callback throwing `'oops'` yields `isOK() === true`). `Result.from` routes
  non-Errors to `ok`. An exception during error handling must not become success. Fix:
  `Result.toError`.
- **`src/result.ts:90` — `map` stores a thrown non-Error unwrapped as `E`**, violating
  `E extends Error` (verified). Same fix. Related asymmetry: `map` returning an `Error` value
  → `ok(Error)`, `mapError` returning an `Error` → error Result; pick one semantic and
  document it.
- `src/async-result.ts:24` — `AsyncResult.all` casts rejection reasons (`reason as E`);
  non-Error rejections yield Results whose `error` isn't an `Error`, inconsistent with
  `AsyncResult.resolve` which normalizes via `Result.toError`.

## Decision gate — predicate narrowing (before freeze)

- **`src/option.ts:30-36` / `src/result.ts:45-51` — `isSome()`/`isOK()` type predicates are
  broken:** the false branch narrows to `never` (verified with the repo's tsc), so
  `if (!opt.isSome())` code paths type-check as unreachable. This is a hazard for every
  consumer. Fix: discriminated subtypes, or drop `this is` and return plain `boolean`.
  Pick one — it shapes the public type surface.

## Minor

- `Result.toError`'s `createError` factory doesn't receive `cause` and is ignored when the
  cause is an `Error` — callers can't wrap Error causes in domain errors.
- `AsyncResult`'s `static [Symbol.species] = Promise` has no effect (not a Promise subclass);
  dead code.

## Test-coverage gaps

Non-Error throws in `map`/`mapError`; `AsyncResult.all` with non-Error reasons.
