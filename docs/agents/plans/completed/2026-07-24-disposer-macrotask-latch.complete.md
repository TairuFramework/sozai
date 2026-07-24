# disposer — pin + document the macrotask-fallback reason latch

**Status:** complete
**Date:** 2026-07-24
**Packages:** `@sozai/async` (no version bump — docs + test only)
**Source:** [backlog/2026-07-14-disposer-macrotask-fallback-reason-latch](../backlog/) (removed on completion),
a follow-up from [2026-07-14-disposer-defer-aborted-signal](2026-07-14-disposer-defer-aborted-signal.complete.md).

## Goal

`Disposer` latches the external abort reason when constructed with an already-aborted signal, so a
`dispose()` racing the deferred dispose receives that reason rather than a substituted
`DisposeInterruption`. The latch clears within one turn on a host with a true-microtask
`queueMicrotask`, but on React Native's legacy Promise (where `scheduleMicrotask`'s fallback lands
on `setImmediate`, a macrotask) it stays observable across later turns. The backlog item was to
decide whether the platforms should agree and pin the behavior.

## Decision

**Pin and document — no behavior change (backlog Option A).** The divergence is intentional and
defensible: the external signal genuinely aborted, so delivering its reason is correct on either
platform. Two convergence alternatives were rejected:

- *Always external reason on both platforms* — changes native behavior for a case no in-repo
  consumer hits.
- *Latch = construction frame only on both* — unreachable: the fallback platform has no
  sub-macrotask deferral primitive, so it cannot clear the latch sooner than the dispose. It would
  ship "they now agree" that only half-holds.

The one genuine defect was that the fallback path had **zero test coverage** — every existing
`Disposer` test runs the native `queueMicrotask`, so a refactor could silently flip the divergence.

## What was built

- **JSDoc on `Disposer`** (`packages/async/src/disposer.ts`) — states the latch guarantee and that
  the native/RN-legacy divergence is intentional. No production logic touched.
- **One test** (`packages/async/test/disposer.test.ts`) — models RN-legacy timing by stubbing
  `queueMicrotask` to route through `setImmediate`, `resetModules` + re-imports `Disposer` (the
  pattern `microtask.test.ts` already uses), then asserts that after an intervening microtask turn a
  bare `dispose()` still receives the external reason. Pins the previously-uncovered fallback path.

## Verification

- `@sozai/async` vitest 18/18 green (+1).
- `tsc --noEmit` clean, biome clean.
- Mutation-sanity: stripping the `#pendingReason` read from `dispose()` makes exactly the new test
  fail (it then delivers `DisposeInterruption`), confirming the test pins the latch rather than
  passing incidentally.

## Notes

No changeset — the change is JSDoc (ships in `.d.ts`) plus a test, with no behavior or API change.
If the changeset gate ever flags the `src/` touch, a patch is the right bump.
