# flow-graph -- `next()` after a rejected step returns no state

**Status:** open · low priority (pre-existing; no consumer reported it)
**Package:** `@sozai/flow-graph`
**Context:** [completed/2026-09-30-flow-graph-validator-cache](../completed/2026-09-30-flow-graph-validator-cache.complete.md)

## The gap

`FlowRun.next()` in `run.ts` returns `{ done: true, value: getState() }` once the run is closed by
`return()`. When an error is thrown inside the drive generator instead, the generator finishes
with that rejection, and a later `next()` forwards `iterator.next()`, which yields
`{ done: true, value: undefined }`.

A host that catches the rejection and calls `next()` again, then reads `.value.status`, gets a
`TypeError`. This applies to any error thrown in the drive loop. It is now a documented, expected
path: a disposed injected validator cache (`FlowGraphValidatorsError`) interrupts a run in
progress this way.

The README only promises the current state after `return()`, and `getState()` always works, so
hosts have a workaround.

## Proposed fix

In `next()`, when the forwarded iterator result has `done` set and its `value` is `undefined`,
return `{ done: true, value: getState() }`, matching the closed path. Add a test: after an
interrupt rejection, `next()` resolves `done` with the last committed state.
