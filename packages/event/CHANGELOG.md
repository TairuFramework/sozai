# @sozai/event

## 0.1.2

### Patch Changes

- 3140d78: Add `EventsSource` and `EventsSink` view types.

  `EventsSource<Events>` is the listen-only surface (`on`, `once`, `readable`); `EventsSink<Events>`
  is the write-only surface (`emit`, `fire`, `writable`). `EventEmitter` implements both, so a
  holder can be narrowed by annotation to expose only one side — e.g. hand `EventsSource` to a
  consumer that may subscribe but must not emit. Purely additive: no runtime or signature change.

## 0.1.1

### Patch Changes

- Fix the abort-listener leaks found in the 2026-07-02 audit. `on`, `once` and `readable` now subscribe through `@sozai/async`'s new `onAbort` primitive, so an already-aborted signal unsubscribes synchronously instead of hanging, and `readable()` removes its abort listener when the stream is cancelled — previously that listener was never removed. Adds a `@sozai/async` dependency; no public API change.
- Updated dependencies
  - @sozai/async@0.2.0
