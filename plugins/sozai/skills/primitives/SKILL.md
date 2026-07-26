---
name: primitives
description: Use when working with Option, Result, AsyncResult, or JSON patches in sozai.
---

# Sozai primitives

Typed wrappers and JSON patching. `Option`, `Result`, and `AsyncResult` make success and
failure explicit in the type rather than in a thrown value; `@sozai/patch` diffs and applies
JSON patches.

## Packages

- **@sozai/result** — `Result` for explicit success/failure. → `reference/result.md`
  - `Option` for present/absent. → `reference/result-option.md`
  - `AsyncResult` for promise-returning chains. → `reference/result-async.md`
- **@sozai/patch** — JSON patch: `createPatches`, `applyPatches`. → `reference/patch.md`

## Pick this when

Use `@sozai/result` when:

- A synchronous function can fail and callers should handle both outcomes without `try`/`catch` → `Result`, `reference/result.md`
- A value may be absent, such as `Map.get` or nullable config → `Option`, `reference/result-option.md`
- Wrapping an async operation that should stay awaitable and auto-catch promise rejections → `AsyncResult`, `reference/result-async.md`

Use `@sozai/patch` when diffing two JSON-serialisable objects or replaying a stored set of
operations onto one — optimistic state updates, event-sourcing deltas, syncing state across
process boundaries. → `reference/patch.md`

## Related

`/sozai:dataflow` — `@sozai/execution` returns `Result`, and `@sozai/result` builds on `@sozai/async`.
