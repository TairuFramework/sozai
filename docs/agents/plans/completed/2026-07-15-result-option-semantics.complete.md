# Result/Option error semantics + predicate narrowing

**Status:** complete
**Date:** 2026-07-15
**Packages:** `@sozai/result` (breaking `0.1.1` → `0.2.0`, minor), `@sozai/execution` (patch)

## Goal

Fix `@sozai/result`'s `Result`/`Option` error-handling semantics and broken type-predicate
narrowing before the package's API freezes, since downstream repos (`@kokuin`, `@enkaku`,
`@kumiai`) pin published ranges and the type surface ossifies once they do.

## Problems fixed

- **Predicates bought no narrowing.** `Option.isSome(): this is Option<V>` declared the predicate
  type as the receiver type, so the false branch subtracted a type from itself and collapsed to
  `never` — `if (!opt.isSome())` type-checked as unreachable. `Result.isOK()` didn't collapse but
  gave nothing either: after `isError()`, `.error` stayed `E | null`, forcing a cast in
  `@sozai/execution`.
- **Thrown non-Errors escaped normalization.** `mapError`'s catch routed through `Result.from`,
  which sends non-`Error` values to `ok` — so a callback that threw `'oops'` while handling an
  error produced a **success** Result. `map`'s catch stored a thrown non-`Error` unwrapped, and
  `AsyncResult.all` cast rejection reasons, both violating `E extends Error` at runtime.
- **Sync and async disagreed on returned Errors.** `Result.map` returning a bare `Error` yielded
  `ok(Error)`; `AsyncResult.map` piped through `Result.from` and yielded an error Result. Same
  code, different meaning depending on the class.

## Design decisions (rationale preserved)

- **Discriminated unions.** `Result` became `OKResult<V,E> | ErrorResult<V,E>` over a non-exported
  `ResultBase`; `Option` became `SomeOption<V> | NoneOption<V>` over `OptionBase`. Each old name
  survives as a merged type-alias + statics object, so both `Result<V,E>` (type position) and
  `Result.ok(...)` (value position) keep working unchanged. Because the receiver is now a union,
  `isOK()`/`isSome()` narrow **both** branches — the false branch of `isOK()` is `ErrorResult` with
  a non-nullable `error: E`; the false branch of `isSome()` is `NoneOption`, not `never`. Rejected
  alternatives: plain `boolean` predicates narrow nothing; branded intersections on a single class
  narrow only the true branch.
- **Rule A — a returned value is a value.** Only a `throw` or an explicit `Result.error(...)` /
  `ErrorResult` makes an error Result; no `instanceof Error` sniffing on any `map`/`mapError` path.
  One line governs sync and async: **`map`'s bare return is a value, `mapError`'s bare return is an
  error; wrap in `Result.ok` / `Result.error` to say otherwise.** `AsyncResult.map` stopped routing
  its fulfilled path through `Result.from` — the one runtime behavior change a consumer can observe:
  `AsyncResult.map` returning a bare `Error` is now `ok(Error)`, not an error Result. `AsyncResult.mapError`
  was retyped to match: a bare return is a replacement error, and recovery is explicit via
  `Result.ok(v)` / `AsyncResult.ok(v)`. `Result.from` keeps sniffing `instanceof Error` and remains
  the coercion entry point for `unknown`; `Option.map` keeps coercing `null`/`undefined` to `none`
  (absence is the type's meaning, not a runtime guess).
- **Every throw normalizes through `Result.toError`.** Applied to both sync catch paths and
  `AsyncResult.all`'s rejection branch, so a Result's `error` is always a real `Error` — a thrown
  non-`Error` becomes `new Error('Unknown error', { cause })`. `toError` gained a cause-receiving
  factory `toError(cause, createError?: (cause) => E)` that **always wins when provided**, including
  for `Error` causes, so callers can wrap every failure in a domain error. Without a factory,
  behavior is unchanged (Error causes pass through). Zero-arg factories stay assignable.
- **`AsyncResult` stays a class** (`Execution extends AsyncResult` depends on it); its dead
  `static [Symbol.species] = Promise` was removed.

## What was built

- `packages/result/src/option.ts`, `result.ts`, `async-result.ts` rewritten per the above, with
  narrowing assertions added as type-level tests (compiled by `test:types`, so a future regression
  fails the build).
- `@sozai/execution` adapted (the only in-repo consumer): its three `Result.toError` call sites
  restate `cause instanceof Error ? cause : <domain error>` explicitly — required because the
  factory now always wins, or a user's thrown `Error` would be silently re-wrapped in
  `Error('Execution failed')` / `AbortInterruption`. Its observable behavior is identical to before.
  The obsolete `result.error as E | Interruption` cast in `ifError` was removed (narrowing supplies
  the type). Runtime coverage added for the abort-reason pass-through (Error surfaces unchanged;
  non-Error wraps to `AbortInterruption`).
- README documents the semantics; a changeset ships `@sozai/result` minor / `@sozai/execution` patch.

## Incidental repo hardening

While verifying, found and fixed a false-green risk in `turbo.json`: `test:unit` / `test:types`
had no `dependsOn`, so a consumer package could test against a stale built `lib/` of its
dependencies. `build:types` is now a turbo task, `test:unit` depends on `^build:js` and
`test:types` on `^build:types`, with build outputs scoped so the js and types caches don't clobber
each other.

## Breaking changes (in the changeset)

- `new Result(...)` / `new Option(...)` are gone — use the statics. `x instanceof Result` no longer
  works — use `Result.is(x)`.
- `AsyncResult.map` returning a bare `Error` is now an OK Result carrying it, not an error Result.
- `AsyncResult.mapError`'s bare return is now a replacement error; recovery must be explicit.

## Verification

Whole-repo `turbo run test:types test:unit` green (all packages), biome clean. `@sozai/result` 228
unit tests, `@sozai/execution` 197. The throw-becomes-success bug and the `never`-collapse are each
pinned by tests that fail against the pre-change baseline. Per-task reviews (7/7) and a final
whole-branch review returned no correctness findings.
