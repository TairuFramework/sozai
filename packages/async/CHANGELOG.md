# @sozai/async

## 0.2.0

### Minor Changes

- Add the `onAbort` primitive and fix the abort-lifecycle contract bugs found in the 2026-07-02 audit. Landed before the package freezes; the `Deferred` change is a breaking type change.

  - **New export `onAbort(signal: AbortSignal | undefined, fn: () => void): () => void`** — the shared abort-subscription primitive every abort-listener site across the async packages now routes through. An undefined signal returns a noop unsubscribe; an already-aborted signal fires `fn` **synchronously** (abort events don't replay, so listening on an aborted signal previously hung forever); otherwise it subscribes with `{ once: true }` and returns an unsubscribe callers invoke on normal settlement.
  - **`Disposer`'s external signal routed through `onAbort`.** An already-aborted signal now disposes synchronously instead of hanging.
  - **`raceSignal` routed through `onAbort`**, so its listener is removed when the race settles normally rather than leaking until abort.
  - **`Deferred<T>.reject` now takes `unknown`.** The `R` reject-reason generic was dishonest — a rejection reason can be anything — and has been dropped. Code that parameterized `Deferred<T, R>` must drop the second type argument.
