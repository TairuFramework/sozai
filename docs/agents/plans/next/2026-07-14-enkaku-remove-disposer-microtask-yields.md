# Remove Enkaku's `Disposer` microtask yields once `@sozai/async` 0.2.1 lands

**Blocked on:** `@sozai/async` 0.2.1 being published and Enkaku's catalog picking it up.

## Why they exist

`Disposer` used to run its dispose callback synchronously from inside `super()` when constructed with an already-aborted signal — before a subclass constructor had initialized `this`. The callback's first `this` access threw `ReferenceError: Must call super constructor in derived class before accessing 'this'`, which `Disposer` swallowed, resolving `disposed` as though teardown had happened.

Enkaku worked around it per-subclass, by yielding a microtask (`await Promise.resolve()`) at the top of each dispose callback, before any `this` access. Each carries a comment begging the next reader not to delete what looks like a no-op.

The workaround now lives in the base class instead: `@sozai/async` 0.2.1 defers the signal-triggered dispose to a microtask itself. See `docs/agents/plans/completed/2026-07-14-disposer-defer-aborted-signal.complete.md`.

## The work

Enkaku consumes `@sozai/async` from the registry via `catalog:` (a `^0.2.0` range), not as a workspace link, so the yields must stay until the fixed version is actually installed. Once it is, delete them:

- `enkaku/packages/transport/src/index.ts` — `Transport` and `DirectTransports`
- `enkaku/packages/server/src/server.ts` — `Server`

Each removal should be covered by a test that constructs the subclass with an **already-aborted** signal and asserts teardown actually ran (transports disposed, handlers aborted, cleanup interval cleared) — that is the behavior the yields were protecting, and it is what silently broke before.

Note the version constraint is satisfied automatically: 0.2.1 matches `^0.2.0`, so no catalog edit is needed, only an install.
