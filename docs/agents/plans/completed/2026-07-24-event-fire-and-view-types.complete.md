# Completed: `@sozai/event` — fire-and-forget emit + Source/Sink view types

**Date:** 2026-07-24
**Package:** `@sozai/event` (`packages/event`)
**Status:** complete

Two related enhancements to `EventEmitter`, delivered together on the same branch.

## 1. `fire()` — synchronous fire-and-forget emit

**Goal:** make fire-and-forget a first-class, safe call instead of the
`void emitter.emit(name, data).catch(...)` boilerplate, where forgetting the `.catch`
turns a listener failure into an unhandled promise rejection.

**What was built:**
- `fire(name, data?)` — mirrors `emit()`'s overloads (dataless + data variants), calls
  `emit()` without awaiting, attaches a `.catch` that swallows the rejection, returns
  `void` synchronously.
- Optional constructor logger: `new EventEmitter(options?: EventEmitterOptions)` where
  `EventEmitterOptions = { logger?: Logger }`. Swallowed failures are reported via
  `logger.warn('Event listener failed during fire()', { name, error })` when a logger is
  configured; silently discarded otherwise.

**Key design decisions:**
- `fire()` delegates to `emit()` rather than duplicating dispatch — the `.catch` both
  prevents the unhandled rejection and does the optional logging. No separate no-op path
  needed: with no logger, the catch handler runs and does nothing.
- `emit()` semantics left unchanged (still async, still rethrows — single error as-is,
  multiple as `AggregateError`). No success logging; log level fixed at `warn`.
- `Logger` type comes from `@sozai/log` via **type-only import**, so `@sozai/event`
  gains no runtime dependency. Added `@sozai/log` as a `workspace:^` dependency.
  Verified no cycle: `@sozai/log` depends only on `@logtape/logtape`, never on
  `@sozai/event`.

## 2. `EventsSource` / `EventsSink` view types

**Goal:** let callers narrow an `EventEmitter` by annotation so a consumer that should
only listen (or a producer that should only emit) can be handed a restricted surface,
instead of every holder getting the full API.

**What was built:**
- `EventsSource<Events>` — listen-only view: `on`, `once`, `readable`.
- `EventsSink<Events>` — write-only view: `emit` (2 overloads), `fire` (2 overloads),
  `writable`.
- `EventEmitter` now declares `implements EventsSource<Events>, EventsSink<Events>`.

**Key design decisions:**
- Purely additive — no runtime change, no method body or signature change. The
  `implements` clause makes the compiler enforce the class stays assignable to both
  views.
- Consumers narrow by **parameter annotation only** — no wrapper objects, no runtime
  cost. A function taking `EventsSource<E>` cannot call `emit`/`fire`/`writable`.
- Named `Source`/`Sink` (data flows out / in), mirroring the class's existing
  `readable()`/`writable()` stream methods. Rejected `Dispatcher`/`Publisher` (both read
  as emit-side, so `Dispatcher` on the listen side is backwards) and `Reader`/`Writer`.
- Declared as `type` aliases (repo convention, not `interface`); overloaded `emit`/`fire`
  expressed as repeated call signatures. `readable`'s options param is `options?:` in the
  view while the class keeps its default-valued `options = {}` — a default-initialized
  parameter stays call-compatible with an optional one, so assignability holds without
  touching the class.

**Motivating adopters (not changed here — future work):** several stack packages expose
a full emitter through a public `.events` getter but only emit internally
(`@enkaku/transport`/`server`/`client`, `@mokei` host/session, `@kumiai` hub-store) —
`EventsSource` is the listen-only type for those. `@sozai/flow` already fakes an
emit-only slice as `EventEmitter<Events>['emit']`, which `EventsSink` supersedes.

## Testing

Added cases to `packages/event/test/lib.test.ts`:
- `fire()`: returns `undefined` synchronously, listener still runs, rejecting listener
  neither throws nor produces an unhandled rejection, dataless overload dispatches,
  constructor logger's `warn` called once on failure and not called on success.
- View types: one type-level test (validated by `tsc --noEmit -p tsconfig.test.json`)
  asserting `EventEmitter` is assignable to both views, with `// @ts-expect-error`
  negatives confirming `EventsSource` has no emit-side methods and `EventsSink` has no
  listen-side methods.

Final state: `tsc` type check clean, `vitest` 32/32 passing, biome lint clean.

## Changesets

- `fire()`: minor bump (its changeset was authored with the feature work).
- View types: minor bump — `.changeset/event-source-sink-views.md`.

## Notes

- Both features landed on branch `feat/event-fire-and-forget`. Due to uncommitted WIP,
  the `fire()`/logger changes and the view-type changes share commit `d9aba09` (labelled
  for the view types); the branch is intended to be squashed at merge, so the per-commit
  labelling is not load-bearing.
