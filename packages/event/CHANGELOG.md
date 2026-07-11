# @sozai/event

## 0.1.1

### Patch Changes

- Fix the abort-listener leaks found in the 2026-07-02 audit. `on`, `once` and `readable` now subscribe through `@sozai/async`'s new `onAbort` primitive, so an already-aborted signal unsubscribes synchronously instead of hanging, and `readable()` removes its abort listener when the stream is cancelled — previously that listener was never removed. Adds a `@sozai/async` dependency; no public API change.
- Updated dependencies
  - @sozai/async@0.2.0
