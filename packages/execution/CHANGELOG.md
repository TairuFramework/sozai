# @sozai/execution

## 0.2.1

### Patch Changes

- 1406004: `Result` and `Option` are now discriminated unions (`OKResult | ErrorResult`,
  `SomeOption | NoneOption`), so `isOK()`/`isError()`/`isSome()`/`isNone()` narrow both branches —
  `error` is non-nullable inside an `isError()` branch, and the false branch of `isSome()` no longer
  collapses to `never`.

  **Breaking:** `new Result(...)` / `new Option(...)` are gone (use the statics), and `x instanceof
Result` no longer works (use `Result.is(x)`).

  **Breaking:** one semantic now holds sync and async — `map`'s bare return is a value, `mapError`'s
  bare return is an error, and nothing sniffs `instanceof Error` in between. `AsyncResult.map`
  returning a bare `Error` is now an OK Result carrying it, not an error Result.

  **Fixed:** a non-`Error` thrown inside `mapError` produced a _success_ Result. Every throw and
  rejection (including `AsyncResult.all`'s) now normalizes through `Result.toError`, so `error` is
  always a real `Error`.

  `Result.toError`'s factory now receives the cause and always wins, including for `Error` causes,
  so failures can be wrapped in domain errors.

- Updated dependencies [1406004]
  - @sozai/result@0.2.0

## 0.2.0

### Minor Changes

- Fix the teardown and settlement-contract bugs found in the 2026-07-02 audit. Behaviour changes, landed before the package freezes.

  - **Timers and abort listeners are released on normal settlement**, not only inside `abort()`. A successful execution previously kept its timeout timer and abort listener alive until the signal fired, holding the whole execution closure. A pre-aborted signal now returns early instead of arming a timer.
  - **`abort()` and `cancel()` are no-ops once the execution has settled.** A succeeded execution stays `isAborted === false` / `isCanceled === false` / `isDisposed === false` / `isTimedOut === false`; previously a late `abort()` retroactively flipped those flags on a completed execution.
  - **A throwing `NextFn` produces an error `Result`** rather than throwing out of the chain, preserving the always-returns-a-`Result` contract.
  - **Dispose-before-start short-circuits** on the internal started flag instead of forcing the lazy execution it is disposing.
  - Documented the lazy/eager split.

### Patch Changes

- Updated dependencies
  - @sozai/async@0.2.0
  - @sozai/result@0.1.1
