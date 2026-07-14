# @sozai/async

## 0.2.1

### Patch Changes

- a8553ad: `Disposer` no longer runs its dispose callback during `super()`.

  Constructing a `Disposer` **subclass** with a signal that had **already** aborted ran the dispose
  callback synchronously from inside `super()`, before the derived constructor body had initialized
  `this`. Any `this` access in the callback — which every real subclass does on its first line — threw
  `ReferenceError: Must call super constructor in derived class before accessing 'this'`. `Disposer`
  caught it, warned, and resolved `disposed` anyway: teardown never ran, and the caller was told it
  succeeded. Reusing a shared shutdown signal that has already fired is enough to hit this.

  The signal-triggered dispose is now scheduled on a microtask when the signal is already aborted, so
  the derived constructor always completes first. Scheduling goes through `queueMicrotask` where the
  host provides it and falls back to a promise continuation where it does not (Hermes/Expo, QuickJS,
  older React Native).

  **Observable change, despite the patch version:** after `new Disposer({ signal })` with an
  already-aborted `signal`, `disposer.signal.aborted` now reads `false` until the current synchronous
  frame completes, then flips to `true`. The dispose callback still runs exactly once with the external
  abort reason, and `disposed` still resolves. A signal that aborts _after_ construction still disposes
  synchronously — that path is unchanged. Subclass authors who relied on teardown having completed
  synchronously by the time the constructor returned should re-check those call sites.

## 0.2.0

### Minor Changes

- Add the `onAbort` primitive and fix the abort-lifecycle contract bugs found in the 2026-07-02 audit. Landed before the package freezes; the `Deferred` change is a breaking type change.

  - **New export `onAbort(signal: AbortSignal | undefined, fn: () => void): () => void`** — the shared abort-subscription primitive every abort-listener site across the async packages now routes through. An undefined signal returns a noop unsubscribe; an already-aborted signal fires `fn` **synchronously** (abort events don't replay, so listening on an aborted signal previously hung forever); otherwise it subscribes with `{ once: true }` and returns an unsubscribe callers invoke on normal settlement.
  - **`Disposer`'s external signal routed through `onAbort`.** An already-aborted signal now disposes synchronously instead of hanging.
  - **`raceSignal` routed through `onAbort`**, so its listener is removed when the race settles normally rather than leaking until abort.
  - **`Deferred<T>.reject` now takes `unknown`.** The `R` reject-reason generic was dishonest — a rejection reason can be anything — and has been dropped. Code that parameterized `Deferred<T, R>` must drop the second type argument.
