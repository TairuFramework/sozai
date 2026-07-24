# @sozai/event

Typed event emitter with built-in stream bridging and `on`/`once`/`emit`/`fire` plus source/sink views.

## Installation

```sh
pnpm add @sozai/event
```

## Usage

```ts
import { EventEmitter } from '@sozai/event'

type Events = {
  data: { value: number }
  done: void
}

const emitter = new EventEmitter<Events>()

// Subscribe; `off()` unsubscribes
const off = emitter.on('data', (e) => console.log(e.value))

await emitter.emit('data', { value: 42 }) // awaits listeners, rethrows failures
emitter.fire('done')                      // fire-and-forget, errors swallowed

off()
```

Also provides `once`, `readable`/`writable` stream bridges, and the listen-only `EventsSource` / write-only `EventsSink` views — see [the dataflow reference](../../docs/reference/dataflow.md) for the full API.
