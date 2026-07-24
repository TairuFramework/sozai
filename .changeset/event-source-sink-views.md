---
'@sozai/event': patch
---

Add `EventsSource` and `EventsSink` view types.

`EventsSource<Events>` is the listen-only surface (`on`, `once`, `readable`); `EventsSink<Events>`
is the write-only surface (`emit`, `fire`, `writable`). `EventEmitter` implements both, so a
holder can be narrowed by annotation to expose only one side — e.g. hand `EventsSource` to a
consumer that may subscribe but must not emit. Purely additive: no runtime or signature change.
