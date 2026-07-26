# @sozai/generator

Utilities that bridge `EventEmitter` instances and `ReadableStream`s into typed async generators. Depends on `@sozai/async` and `@sozai/event`.

## Exports

| Export | Kind | Description |
|---|---|---|
| `consume` | function | Drive an `AsyncIterator<T>` to completion, calling a callback for each value; respects `AbortSignal` — calls `iterator.return()` and rejects on abort; returns `Promise<TReturn>` resolving to the iterator's return value |
| `fromEmitter` | function | Return an `AsyncGenerator` that yields events from an `EventEmitter` channel; supports `filter` and `AbortSignal`. Implements `Symbol.asyncDispose` |
| `fromStream` | function | Return an `AsyncGenerator` that yields chunks from a `ReadableStream`; cancels the stream on early exit (`return()`/`break`) unless `preventCancel` is set |

`fromEmitter` defines `[Symbol.asyncDispose]` on its returned object, calling `stop()` directly;
`fromStream`, a native `async function*`, inherits `[Symbol.asyncDispose]` from the async-generator
prototype (`AsyncGenerator extends AsyncIteratorObject extends AsyncDisposable`, in
`lib.esnext.disposable.d.ts`), which calls `.return()` and runs its own `try`/`finally` that
cancels the reader. Both therefore work with `break`/`return` in a `for await` loop and with
`await using` — but neither implements the synchronous `Symbol.dispose`, so plain `using` fails
to compile (`TS2850`) and throws at runtime.

## Example: consuming an event stream as an async generator

```typescript
import { EventEmitter } from '@sozai/event'
import { fromEmitter, consume } from '@sozai/generator'

type Events = { tick: number }
const emitter = new EventEmitter<Events>()

const controller = new AbortController()

// fromEmitter: iterate events as an async generator
const ticks = fromEmitter(emitter, 'tick', {
  filter: (n) => n % 2 === 0,
  signal: controller.signal,
})

// Kick off the consumer in the background
const done = consume(
  ticks,
  (n) => console.log('even tick:', n),
  controller.signal,
)

await emitter.emit('tick', 1)  // filtered out
await emitter.emit('tick', 2)  // logs 'even tick: 2'
await emitter.emit('tick', 4)  // logs 'even tick: 4'

controller.abort()
await done.catch(() => {}) // resolves once iterator is cleaned up
```

## Example: consuming a ReadableStream as an async generator

```typescript
import { createReadable } from '@sozai/stream'
import { fromStream } from '@sozai/generator'

const [source, ctrl] = createReadable<string>()
ctrl.enqueue('a')
ctrl.enqueue('b')
ctrl.enqueue('c')
ctrl.close()

for await (const chunk of fromStream(source)) {
  console.log(chunk) // 'a', 'b', 'c'
}
```
