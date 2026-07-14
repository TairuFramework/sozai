# `Disposer`'s reason latch stays live longer under the macrotask fallback

Low priority — the divergent behavior is arguably the more correct one. This is about pinning and documenting it, not fixing a break.

## What

`Disposer` defers its dispose to a microtask when constructed with an already-aborted signal, and latches the external abort reason (`#pendingReason`) so that anything disposing in the same synchronous frame as construction still receives that reason rather than a substituted `DisposeInterruption`. Background: `docs/agents/plans/completed/2026-07-14-disposer-defer-aborted-signal.complete.md`.

The scheduler (`packages/async/src/microtask.ts`) uses the host `queueMicrotask` when available and falls back to `Promise.resolve().then` otherwise. Under React Native's legacy Promise polyfill that continuation lands on `setImmediate` — a **macrotask**. The latch therefore stays live across microtask turns on that platform, where on a native host it is cleared within one.

Observable difference: on such a host, a caller's own bare `dispose()` issued after a microtask turn but before the scheduled macrotask fires receives the **external** reason, where a native host would give it a `DisposeInterruption`.

## Why it was left

The external signal genuinely *had* aborted, so the external reason is defensible — arguably better than the substituted interruption. Nothing depends on the fallback being a true microtask; the deferral only needs "after the current synchronous frame", which both paths satisfy. No in-repo consumer is affected (sozai has zero `Disposer` subclasses).

## The work, if picked up

- Decide whether the two platforms should agree, and which way.
- If they should agree: clear the latch on a microtask independently of when the dispose fires, or gate the latch read on a "still in the construction frame" flag.
- Either way, add a test that simulates the macrotask fallback (stub `queueMicrotask` to `undefined`, as `test/microtask.test.ts` already does, and drive a `Disposer` through it), and say what the guarantee is in the `Disposer` JSDoc.
