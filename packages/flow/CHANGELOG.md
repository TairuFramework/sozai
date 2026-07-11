# @sozai/flow

## 0.2.0

### Minor Changes

- Fix the state-isolation and reentrancy bugs found in the 2026-07-02 audit. Behaviour changes, landed before the package freezes.

  - **`getState()` returns a frozen shallow clone.** It previously handed out the live state object, so a caller mutating the returned value poisoned the flow's own state.
  - **`defaultAction` is applied only on the first `next()`**, then cleared. It was re-applied on every call, so a flow with a default action never terminated under `for await`.
  - **Concurrent `next()` calls throw** via a reentrancy guard instead of interleaving and corrupting state.
  - The aborted done-value `reason` is typed `unknown` (an abort reason can be anything).

### Patch Changes

- Updated dependencies
- Updated dependencies [29345c8]
  - @sozai/event@0.1.1
  - @sozai/schema@0.1.1
