# `Disposer` runs its dispose callback before a subclass has initialized

**Origin:** found by review during Enkaku's `abort-signal-and-release-lifecycle` branch (2026-07-13), where it had to be patched in **three** places downstream. This is the upstream fix.

## The bug

`packages/async/src/disposer.ts:54` ends the constructor with:

```ts
this.#unsubscribeSignal = onAbort(params.signal, () => this.dispose(params.signal?.reason))
```

`onAbort` invokes its callback **synchronously** when the signal is already aborted (`on-abort.ts:17-19`). So constructing any `Disposer` subclass with an **already-aborted** signal runs `dispose()` from inside `super()` — before the derived constructor body has run, and therefore before `this` is initialized in the derived class.

Every real subclass's dispose callback touches `this` on its first line (typically `await this.#events.emit('disposing', ...)`). That throws `ReferenceError: Must call super constructor in derived class before accessing 'this'`. `Disposer` **catches it** (the `params.dispose(...).then(ok, err)` chain), `console.warn`s, and **resolves `disposed` anyway**.

Net effect: `dispose()` reports success while teardown never happened. Confirmed empirically against Enkaku's `Server`:

```
Disposer dispose callback rejected ReferenceError: Must call super constructor in derived class...
server.disposed: DISPOSED_RESOLVED
disposing fired: 0
disposed fired: 0
```

Its transports were never disposed, its handlers never aborted, its cleanup interval never cleared — and the caller was told it all went fine. A caller reusing a shared shutdown signal that has already fired is not exotic.

## Why it belongs here

Enkaku patched it per-subclass by yielding a microtask (`await Promise.resolve()`) at the top of the dispose callback, before any `this` access. That now appears in **three** places there (`Transport`, `DirectTransports`, `Server`), each carrying a comment begging the next reader not to delete what looks like a no-op.

Any `Disposer` subclass — in any repo in the stack — that forwards an external signal and touches `this` in its dispose callback reintroduces this silently. It is a property of the base class, so it should be fixed in the base class.

## Sketch

Defer the signal-triggered `dispose()` invocation by a microtask, so the derived constructor always completes first.

The soundness argument (verified downstream): constructors are **synchronous** in JS — you cannot `await` inside one — so the entire synchronous unwind (out of the abort listener, out of `Disposer`'s constructor, out of `super()`, through the derived constructor's remaining field assignments) completes *before* the engine drains the microtask queue. A microtask continuation therefore always observes a fully-initialized `this`.

**Caveat to preserve:** this holds only while nothing between `super()` and the derived class's field assignments can throw. If something ever did, the failure mode degrades from a loud `ReferenceError` to a silent `undefined` field access.

Consider also whether `Disposer` should keep swallowing a **rejected** dispose callback into a **resolved** `disposed`. That swallow is what turned a loud error into a silent success and is the reason this went unnoticed for so long — arguably `disposed` should reject, or at least a `disposeFailed` signal should exist.

## Blast radius

`Disposer` is the shared teardown primitive across the stack. Changing *when* the signal-triggered dispose fires is a real behavior change: it wants its own changeset and a check of every subclass in `@sozai`, `@enkaku`, `@kokuin`, and `@kumiai`.

## Downstream cleanup, after release

Enkaku consumes `@sozai/async` from the registry (`catalog:`, currently `0.2.0`), not as a workspace link — so its three microtask yields must stay until a fixed version ships. Once released and the catalog is bumped, remove them:

- `enkaku/packages/transport/src/index.ts` — `Transport` and `DirectTransports`
- `enkaku/packages/server/src/server.ts` — `Server`
