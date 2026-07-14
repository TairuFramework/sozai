# `Disposer`: defer dispose when constructed with an already-aborted signal

**Status:** complete
**Date:** 2026-07-14
**Package:** `@sozai/async` (patch, 0.2.0 → 0.2.1)
**Origin:** found by review during Enkaku's `abort-signal-and-release-lifecycle` branch (2026-07-13), where it had to be patched in three places downstream. This was the upstream fix.

## The bug

`Disposer`'s constructor ended by registering its external-signal abort listener through `onAbort`, which invokes its callback **synchronously** when the signal is already aborted. Constructing a `Disposer` **subclass** with an already-aborted signal therefore ran `dispose()` from inside `super()` — before the derived constructor body had run, and so before `this` was initialized in the derived class.

Every real subclass's dispose callback touches `this` on its first line (typically `await this.#events.emit('disposing', …)`). That threw `ReferenceError: Must call super constructor in derived class before accessing 'this'`. `Disposer` **caught it**, warned, and **resolved `disposed` anyway** — so `dispose()` reported success while teardown never happened. Confirmed empirically against Enkaku's `Server`: its transports were never disposed, its handlers never aborted, its cleanup interval never cleared, and the caller was told it all went fine. A caller reusing a shared shutdown signal that has already fired is not exotic.

The base class itself was safe (its own fields initialize before the `onAbort` line), which is why the bug survived the existing test suite: only derived classes broke.

## What was built

On an already-aborted signal, `Disposer` now schedules `this.dispose(reason)` on a microtask instead of letting `onAbort` fire it synchronously. Signals that abort *later* still dispose synchronously — that path is unchanged.

Scheduling goes through a new **internal** `scheduleMicrotask` helper (`packages/async/src/microtask.ts`), deliberately not exported from `index.ts`.

## Key design decisions

- **The fix lives in `Disposer`, not `onAbort`.** `onAbort`'s synchronous-fire-on-already-aborted contract is depended on by `execution`, `event`, `lock`, `generator`, and `stream` (ten call sites). Changing it there would have been a far wider blast radius than the bug warranted. The bug is a property of the base class, so the base class absorbs it.

- **Defer only the already-aborted case.** A uniform "always defer" would have delayed every external-signal teardown and made `signal.aborted` lag the external abort for all consumers, not just the broken ones.

- **Soundness of the microtask.** Constructors are synchronous in JS — you cannot `await` inside one — so the entire synchronous unwind (out of `Disposer`'s constructor, out of `super()`, through the derived class's field initializers and constructor body) completes before the engine drains the microtask queue. The callback therefore always observes a fully-initialized `this`.

- **`queueMicrotask` is detected, not assumed.** It is a WHATWG/Node host API, **not** ECMA-262: Hermes does not define it. React Native polyfills it, so modern Expo/RN has it, but bare Hermes, QuickJS and older RN do not. `@sozai/async` ships to Expo and has zero dependencies (so it cannot reach for `@sozai/runtime`), hence the local `Promise.resolve().then` fallback. Detection is a bare `typeof queueMicrotask` check, not `globalThis.queueMicrotask` — some RN polyfills install it as a global binding without a `globalThis` property.

- **The external abort reason is latched (`#pendingReason`).** Caught by the final review: with the dispose deferred, anything calling `dispose()` or `[Symbol.asyncDispose]()` in the *same synchronous frame* as construction (e.g. `await using d = new Disposer({ signal: alreadyAborted })` in a block that exits synchronously) beat the microtask, and `dispose()` substituted a `DisposeInterruption` — silently losing the external reason. `dispose()` now resolves its reason as `reason ?? this.#pendingReason ?? new DisposeInterruption()`, so an explicit reason still wins, a bare `dispose()` inherits the external one. Safe because a natively aborted `AbortSignal.reason` is never `undefined` (the spec substitutes an `AbortError` DOMException).

- **The rejected-dispose swallow was left alone.** `Disposer` still turns a rejected dispose callback into a *resolved* `disposed` (with `console.warn`, or `onDisposeError` when supplied). That swallow is what converted the `ReferenceError` into a silent success, so it was tempting to change — but rejecting `disposed` is breaking (it is frequently held without a `catch`, and `dispose()` is often called from a `finally`), and a `disposeError` getter would be new public API forcing a minor, which `^0.2.0` consumers would not pick up. The root cause is gone; revisit only if a real dispose callback starts failing silently for another reason.

- **Patch, not minor**, despite an observable timing change (`signal.aborted` now reads `false` until the construction frame completes). `^0.2.0` consumers — including Enkaku, which is running the buggy version — pick it up with no catalog edit. The changeset spells the change out explicitly for anyone who reads it.

## Known residual

Under React Native's legacy Promise polyfill the fallback lands on `setImmediate` (a macrotask, not a microtask), so the reason latch stays live across microtask turns there. A caller's own bare `dispose()` in that window gets the external reason instead of a `DisposeInterruption` — arguably the truer reason, but it is a platform-conditional difference that is untested and not mentioned in the changeset. See `docs/agents/plans/backlog/2026-07-14-disposer-macrotask-fallback-reason-latch.md`.

The documented caveat of the deferral is pinned by a test: if a derived constructor **throws** after `super()` returns, the scheduled dispose still fires on the discarded, half-built instance — field initializers have run, constructor-body assignments read as `undefined`. This is not worse than the pre-fix behavior (which ran no teardown at all and resolved `disposed`), so it stands as documented, not fixed.

## Status

Shipped on branch `fix/disposer-defer-aborted-signal`. 119 tests in `@sozai/async`, whole-repo `test:unit` green across 14 packages. Zero `Disposer` subclasses exist in sozai, so nothing in-repo is affected by the timing change.

Downstream cleanup is tracked in `docs/agents/plans/next/2026-07-14-enkaku-remove-disposer-microtask-yields.md`.
