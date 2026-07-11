# @sozai/execution

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
