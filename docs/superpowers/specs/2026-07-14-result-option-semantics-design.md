# @sozai/result — error-handling semantics + predicate narrowing

**Date:** 2026-07-14
**Package:** `@sozai/result` (currently `0.1.1`) — breaking `0.2.0`
**Source:** [audit 2026-07-02 — result](../../agents/plans/completed/2026-07-02-repo-audit.complete.md#result)

## Problem

`Result`/`Option` sit under most error handling in the stack and are a freeze-blocker: once
downstream repos (`@kokuin`, `@enkaku`, `@kumiai`) pin published ranges, the type surface
ossifies. Three classes of defect, all verified against the repo's `tsc` and test runner.

### Predicates buy no narrowing

`Option.isSome(): this is Option<V>` declares the predicate type as the receiver type, so the
false branch subtracts a type from itself and collapses to `never` — `if (!opt.isSome()) { ... }`
type-checks as unreachable code. Confirmed: assigning the narrowed `opt` to `never` compiles.

`Result.isOK(): this is Result<V, never>` does *not* collapse (the false branch stays
`Result<V, E>`), but it delivers nothing either: after `isError()`, `.error` is still `E | null`
and `.value` is still `V` despite throwing at runtime. `packages/execution/src/execution.ts:267`
casts `result.error as E` for exactly this reason. The audit reported this one as a `never`
collapse; that is wrong, but the fix is the same.

### Thrown non-Errors escape normalization

- `result.ts:105` — `mapError`'s catch routes through `Result.from`, which sends non-`Error`
  values to `ok`. **A callback that throws `'oops'` while handling an error yields
  `isOK() === true`.** An exception during error handling must never become a success.
- `result.ts:90` — `map`'s catch stores a thrown non-`Error` unwrapped as `E`, violating
  `E extends Error` at runtime.
- `async-result.ts:24` — `AsyncResult.all` casts rejection reasons (`reason as E`), so
  non-`Error` rejections produce Results whose `error` is not an `Error` — inconsistent with
  `AsyncResult.resolve`, which normalizes via `Result.toError`.

### Sync and async disagree on returned Errors

`Result.map` returning a bare `Error` value yields `ok(Error)` (no runtime sniffing).
`AsyncResult.map` pipes its fulfilled value through `Result.from`, which sniffs `instanceof
Error` and yields an **error** Result. Identical code means different things depending on
whether it runs through the sync or async class. Not in the audit; found while exploring.

## Design

### 1. `Result` becomes a discriminated union

One class becomes a non-exported base plus two concrete classes. `Result` survives as a type
alias merged with a statics object, so both `Result<V, E>` (type position) and `Result.ok(...)`
(value position) keep working unchanged at call sites.

```ts
abstract class ResultBase<V, E extends Error> {   // not exported
  #state: ResultState<V, E>
  #optional?: Option<V>
  // map, mapError, or, orNull, optional
}

export class OKResult<V, E extends Error = Error> extends ResultBase<V, E> {
  isOK(): this is OKResult<V, E>       // true
  isError(): this is ErrorResult<V, E> // false
  get value(): V
  get error(): null
}

export class ErrorResult<V, E extends Error = Error> extends ResultBase<V, E> {
  isOK(): this is OKResult<V, E>       // false
  isError(): this is ErrorResult<V, E> // true
  get value(): never   // throws the error
  get error(): E
}

export type Result<V, E extends Error = Error> = OKResult<V, E> | ErrorResult<V, E>
export const Result = { ok, error, from, is, toError }
```

Because the receiver is now a union, `isOK()` narrows **both** branches: true to `OKResult`
(`.value: V`, `.error: null`), false to `ErrorResult` (`.error: E`, non-nullable). The false
branch is where error handling lives, which is why the other candidate designs were rejected —
plain `boolean` predicates narrow nothing, and branded intersections on a single class narrow
only the true branch.

`Result.is` becomes `value instanceof ResultBase`. `map`/`mapError` stay on the base and keep
returning the union type.

**Breaking:** `new Result(state)` and `x instanceof Result` no longer exist. The constructor took
an internal `ResultState`; `Result.is` is the supported check and is unaffected.

### 2. `Option` gets the same shape

`SomeOption<V>` (`orThrow: V`, `orNull: V`) and `NoneOption<V>` (`orThrow: never`, `orNull:
null`), with `Option` as a type alias plus statics. The false branch of `isSome()` resolves to
`NoneOption` instead of subtracting a type from itself, which is the `never`-collapse fix.

### 3. Returned values are values; only throws and explicit errors are errors

The rule, to be documented in the package README:

> A value **returned** from a callback is a success value, whatever its runtime type. Only a
> **throw**, or an explicit `Result.error(...)` / `ErrorResult`, produces an error Result.

Consequences:

- `Result.map(v => new Error('x'))` yields `ok(Error)`. Unchanged sync behavior, now deliberate:
  the callback's declared return type says the value is an `OutV`, and a runtime `instanceof`
  check that contradicts the signature makes `Result<Error, E>` unrepresentable through `map`.
- `AsyncResult.map` stops routing its fulfilled path through `Result.from` and adopts the sync
  semantic. **This is the one behavior change a consumer could observe at runtime.**
- `mapError(fn)` returning a bare `OutE` still means "replacement error" — that is what its
  signature (`(error: E) => OutE | Result<V, OutE>`) declares, not a runtime sniff. The
  sync/async asymmetry the audit flagged here is only apparent: it falls out of the two
  signatures, and both are correct.
- `Option.map` keeps coercing `null`/`undefined` to `none`. For `Option`, absence *is* the type's
  meaning, so this is the signature speaking, not a runtime guess contradicting it.
- `Result.from` keeps sniffing `instanceof Error`. It stays the coercion entry point for
  `unknown` — it is simply no longer used on `map` fulfillment paths.

### 4. Every throw normalizes through `Result.toError`

Applies to `Result.map`'s catch, `Result.mapError`'s catch, and `AsyncResult.all`'s rejection
branch. After this, `E extends Error` holds at runtime, not just on paper.

`toError` gains a cause-aware factory:

```ts
static toError<V, E extends Error = Error>(
  cause: unknown,
  createError?: (cause: unknown) => E,
): ErrorResult<V, E>
```

When `createError` is provided it **always** wins — including when the cause is already an
`Error` — so a caller can wrap every failure in a domain error
(`(cause) => new DomainError('failed', { cause })`). Without a factory, behavior is unchanged:
`Error` causes pass through, non-`Error` causes become `new Error('Unknown error', { cause })`.
Existing zero-arg factories stay assignable to `(cause: unknown) => E` and keep compiling; they
will now also fire on `Error` causes, which is the intent.

The dead `static [Symbol.species] = Promise` is deleted from `AsyncResult` (it has no effect —
`AsyncResult` is not a `Promise` subclass).

`AsyncResult` remains a class. `Execution extends AsyncResult<V, E | Interruption>` in
`@sozai/execution` depends on that and is unaffected.

## Fallout

`@sozai/execution` is the only in-repo consumer:

- `execution.ts:267` — the `result.error as E | Interruption` cast is deleted; narrowing supplies
  the type.
- `Result.toError` call sites (`execution.ts:106`, `:117`, `:230`) are re-checked against the new
  factory arity.

Downstream repos take a breaking `0.2.0` via changeset.

## Testing

- Non-`Error` throws in `map` and `mapError`, sync and async — assert `isError()` and that
  `error instanceof Error` with the thrown value as `cause`. The `mapError` case is the
  throw-becomes-success bug and must fail against current `main`.
- `AsyncResult.all` with non-`Error` rejection reasons — assert normalized `Error` errors.
- `Result.toError` with a factory and an `Error` cause — assert the factory runs and receives the
  cause.
- `map` returning a bare `Error` stays `ok` in **both** `Result` and `AsyncResult`.
- Narrowing, as type-level assertions that fail the build if a false branch collapses again: in
  the false branch of `isOK()`, `.error` is `E` (not `E | null`); in the false branch of
  `isSome()`, the receiver is `NoneOption<V>` (not `never`).
