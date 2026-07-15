---
'@sozai/result': minor
'@sozai/execution': patch
---

`Result` and `Option` are now discriminated unions (`OKResult | ErrorResult`,
`SomeOption | NoneOption`), so `isOK()`/`isError()`/`isSome()`/`isNone()` narrow both branches —
`error` is non-nullable inside an `isError()` branch, and the false branch of `isSome()` no longer
collapses to `never`.

**Breaking:** `new Result(...)` / `new Option(...)` are gone (use the statics), and `x instanceof
Result` no longer works (use `Result.is(x)`).

**Breaking:** one semantic now holds sync and async — `map`'s bare return is a value, `mapError`'s
bare return is an error, and nothing sniffs `instanceof Error` in between. `AsyncResult.map`
returning a bare `Error` is now an OK Result carrying it, not an error Result.

**Fixed:** a non-`Error` thrown inside `mapError` produced a *success* Result. Every throw and
rejection (including `AsyncResult.all`'s) now normalizes through `Result.toError`, so `error` is
always a real `Error`.

`Result.toError`'s factory now receives the cause and always wins, including for `Error` causes,
so failures can be wrapped in domain errors.
