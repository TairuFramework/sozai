# @sozai/generator

## 0.2.0

### Minor Changes

- Fix the concurrency and listener-lifecycle bugs found in the 2026-07-02 audit. Behaviour changes, landed before the package freezes.

  - **`fromEmitter` no longer drops concurrent `next()` callers.** Pending reads were held in a single deferred that each new `next()` overwrote, so the first waiter hung forever. Pending reads are now a FIFO queue.
  - **Emitter listeners are removed on completion/stop** in both `consume` and `fromEmitter`, not only on abort — previously a normally-completed generator leaked its listener for the lifetime of the emitter.
  - **Aborting `consume` rejects with an `AbortInterruption`** instead of a bare `reject(undefined)`. `AbortController.abort()` with no argument auto-fills `signal.reason` with an `AbortError` `DOMException`, which is preserved as the interruption's `cause`.

### Patch Changes

- Updated dependencies
  - @sozai/async@0.2.0
