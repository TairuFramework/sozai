# @sozai/generator

Bridges `EventEmitter` channels and `ReadableStream`s into typed async generators.

## Installation

```sh
pnpm add @sozai/generator
```

## Usage

```ts
import { EventEmitter } from '@sozai/event'
import { fromEmitter, consume } from '@sozai/generator'

type Events = { tick: number }
const emitter = new EventEmitter<Events>()
const controller = new AbortController()

// Iterate an event channel as an async generator, then drive it to completion.
const ticks = fromEmitter(emitter, 'tick', { signal: controller.signal })
const done = consume(ticks, (n) => console.log('tick:', n), controller.signal)

await emitter.emit('tick', 1)
await emitter.emit('tick', 2)
controller.abort()
await done.catch(() => {})
```

Also provides `fromStream` for consuming a `ReadableStream` as a generator — see [the generator reference](../../plugins/sozai/skills/dataflow/reference/generator.md) (part of the `sozai:dataflow` skill) for the full API.
