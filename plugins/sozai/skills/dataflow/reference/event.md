# @sozai/event

Typed event emitter with built-in stream bridging. A custom, lightweight implementation (not based on an external library).

## Exports

| Export | Kind | Description |
|---|---|---|
| `EventEmitter` | class | Typed emitter: `on`, `once`, `emit`, `fire`, `readable`, `writable`. Constructor takes an optional `{ logger? }` |
| `UnsubscribeFunction` | type | `() => void` returned by `on` |
| `ListenerOptions` | type | `{ filter?, signal? }` for `on` / `readable` |
| `DatalessEventNames` | type | Union of event names whose payload type is `void` |

## Methods on `EventEmitter<Events>`

| Method | Description |
|---|---|
| `on(name, listener, options?)` | Subscribe; returns `UnsubscribeFunction` |
| `once(name, options?)` | Returns a `Promise` that resolves on the next matching event |
| `emit(name, data?)` | Emit to all listeners; awaits and rethrows listener failures (one as-is, several as an `AggregateError`) |
| `fire(name, data?)` | Fire-and-forget emit; does not await, and swallows listener failures — logs via the constructor's `logger` if given, otherwise discards them |
| `readable(name, options?)` | Bridge: events → `ReadableStream`; closes when `signal` aborts or stream is cancelled |
| `writable(name)` | Bridge: `WritableStream` → events; each written chunk calls `emit` |

## Example: typed emitter and stream bridge

```typescript
import { EventEmitter } from '@sozai/event'
import { createArraySink } from '@sozai/stream'

type Events = {
  data: { value: number }
  done: void
}

const emitter = new EventEmitter<Events>()
const controller = new AbortController()

// Convert matching events to a ReadableStream
const stream = emitter.readable('data', {
  filter: (e) => e.value > 10,
  signal: controller.signal,
})

const [sink, results] = createArraySink<{ value: number }>()
stream.pipeTo(sink)

await emitter.emit('data', { value: 5 })   // filtered out
await emitter.emit('data', { value: 15 })  // included
await emitter.emit('data', { value: 20 })  // included

controller.abort() // closes the stream
// results resolves to [{ value: 15 }, { value: 20 }]
```
