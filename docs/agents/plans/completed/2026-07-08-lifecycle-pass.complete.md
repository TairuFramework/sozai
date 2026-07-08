# lifecycle-pass — teardown-on-settle + contract fixes

**Status:** complete
**Date:** 2026-07-08
**Packages:** `@sozai/async`, `@sozai/generator`, `@sozai/execution`, `@sozai/flow`, `@sozai/event`
**Source:** freeze-blocker from the 2026-07-02 repo audit (execution section).

## Goal

Fix the shared "listeners/timers released only on abort, never on normal
settlement" leak class across the async-primitive packages, plus the
per-package contract bugs the audit verified with runtime repros. Freeze-blocker:
these packages ossify on publish, so the contracts had to be right first.

## Key design decision: the `onAbort` primitive

Introduced a single unifying abstraction, exported publicly (permanent frozen API)
from `@sozai/async`:

```
onAbort(signal: AbortSignal | undefined, fn: () => void): () => void
```

- Undefined signal → noop unsubscribe.
- Already-aborted signal → fires `fn` **synchronously**, returns a noop unsubscribe
  (abort events do not replay for listeners added after the fact — this is the fix
  for the `Disposer` already-aborted hang).
- Otherwise `addEventListener('abort', fn, { once: true })` + an unsubscribe that
  removes it.

Adoption decision: **every** abort-listener site across the five packages routes
through `onAbort` (not only the leaking ones), for uniformity. Callers keep the
returned unsubscribe and invoke it on normal settlement. The synchronous-fire branch
forces a TDZ discipline at every site: any closure/unsubscribe the callback references
is initialized to a noop **before** the `onAbort` call.

A discovered fact drove several fixes: `AbortController.abort()` with no argument
auto-fills `signal.reason` with an `AbortError` `DOMException`, so `signal.reason ??
fallback` never falls back. Reject paths detect that DOMException and convert it to an
`AbortInterruption` (preserving the original as `cause` for debuggability), while
preserving any explicit reason.

## What was built (per package)

- **`@sozai/async`** — `onAbort` primitive + tests; `Disposer` external signal routed
  through it (synchronous dispose on already-aborted); `Deferred<T>.reject` widened to
  `(reason?: unknown)` (dropped the dishonest second `R` generic that falsely claimed
  `never`-rejection); `raceSignal` routed through `onAbort` for uniformity.
- **`@sozai/generator`** — `fromEmitter` concurrent `next()` now uses a **FIFO array**
  of pending deferreds (was a single overwritten deferred that hung the first waiter);
  `consume` + `fromEmitter` abort listeners removed on completion/stop; `consume` bare
  `reject(undefined)` wrapped in `AbortInterruption` with the DOMException preserved as
  cause.
- **`@sozai/execution`** — `#cleanup` (timer cancellation) now runs on normal settle and
  the pre-aborted early return, not only from `abort()`; the per-execution abort listener
  on the (long-lived) composite signal is unsubscribed on settle; `abort()`/`cancel()`
  no-op once a `#settled` flag is set, so a succeeded execution keeps
  `isAborted`/`isCanceled`/`isDisposed`/`isTimedOut` false; a throwing `NextFn` resolves
  to an error `Result` instead of rejecting the Execution (preserves the always-`Result`
  contract); dispose-before-start short-circuits via a `#started` flag rather than forcing
  the lazy and arming timers; docs clarify the lazy `next()` vs eager `map`/`mapError`
  split.
- **`@sozai/flow`** — `getState()` returns `Object.freeze({ ...state })` (frozen shallow
  clone) instead of poisoning live state; `defaultAction` is applied only on the first
  `next()` then cleared (was re-applied every call, looping forever under `for await`);
  a reentrancy guard **throws** on concurrent `next()` and releases in `finally`;
  aborted done-value `reason` typed `unknown` (was `string`, mismatching the impl).
- **`@sozai/event`** — `on`/`once`/`readable` abort wiring routed through `onAbort`;
  `readable()`'s previously un-removed abort listener is now removed on cancel. Added
  `@sozai/async` as a workspace dependency (no cycle — `@sozai/async` has no deps).

## Status

All 16 planned tasks plus 2 uniformity follow-ups (raceSignal, consume cause) landed,
each committed and reviewed. Full workspace `test:types` + `test:unit`: all packages
pass. Whole-branch review verdict: ready to merge, zero critical/important findings.

## Out of scope

- `stream` package robustness (a separate priority item; its abort propagation can reuse
  `onAbort`).
- Any refactor beyond the audit findings and their direct fixes.
