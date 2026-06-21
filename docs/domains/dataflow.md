# Dataflow

Streams, async primitives, events, generators, stateful flow, and execution control for the sozai layer.

## Packages

| Package | Purpose |
|---|---|
| `@sozai/stream` | Web Streams creation, transformation, and JSON Lines encoding |
| `@sozai/async` | Async primitives: deferred promises, lazy evaluation, disposable resources, interruptions |
| `@sozai/event` | Typed event emitter with stream bridging |
| `@sozai/flow` | Async-generator state machine execution |
| `@sozai/generator` | Bridges emitters and streams to async generators |
| `@sozai/execution` | Chainable, cancellable async execution with structured error handling |

---

## @sozai/stream

Web Streams utilities for building composable data pipelines.

### Exports

| Export | Kind | Description |
|---|---|---|
| `createReadable` | function | Create a `ReadableStream` and its `ReadableStreamDefaultController` |
| `createPipe` | function | Create a transform pipe connecting a writable and readable end |
| `createConnection` | function | Create a bidirectional stream connection |
| `writeTo` | function | Write a value into a writable stream |
| `createArraySink` | function | Collect all stream chunks into an array; returns `[WritableStream, Promise<Array<T>>]` |
| `transform` | function | Create a `TransformStream` from a transform function |
| `map` | function | Synchronous value-mapping transform |
| `mapAsync` | function | Async value-mapping transform |
| `tap` | function | Side-effect transform (inspect without changing values) |
| `toJSONLines` | function | Encode objects as newline-delimited JSON (NDJSON) |
| `fromJSONLines` | function | Decode newline-delimited JSON chunks into typed objects |
| `JSONLinesError` | class | Error thrown when a JSON Lines chunk cannot be parsed |

### Example: transformation pipeline

```typescript
import { createReadable, createArraySink, tap, map, mapAsync } from '@sozai/stream'

const [source, controller] = createReadable<number>()
const [sink, result] = createArraySink<string>()

source
  .pipeThrough(tap((n) => console.log('input:', n)))
  .pipeThrough(map((n) => n * 2))
  .pipeThrough(mapAsync(async (n) => `Value: ${n}`))
  .pipeTo(sink)

controller.enqueue(1)
controller.enqueue(2)
controller.enqueue(3)
controller.close()

// result resolves to ['Value: 2', 'Value: 4', 'Value: 6']
```

### Example: JSON Lines (NDJSON)

```typescript
import { createReadable, createArraySink, toJSONLines, fromJSONLines } from '@sozai/stream'

type Message = { id: number; text: string }

// Encode objects to NDJSON
const [source, controller] = createReadable<Message>()
const [sink, encoded] = createArraySink<string>()
source.pipeThrough(toJSONLines()).pipeTo(sink)

controller.enqueue({ id: 1, text: 'Hello' })
controller.enqueue({ id: 2, text: 'World' })
controller.close()
// encoded resolves to ['{"id":1,"text":"Hello"}\n', '{"id":2,"text":"World"}\n']

// Decode NDJSON back to objects
const [jsonSource, jsonController] = createReadable<string>()
const [objectSink, decoded] = createArraySink<Message>()
jsonSource.pipeThrough(fromJSONLines<Message>()).pipeTo(objectSink)

jsonController.enqueue('{"id":1,"text":"Hello"}\n{"id":2,"text":"World"}\n')
jsonController.close()
// decoded resolves to [{ id: 1, text: 'Hello' }, { id: 2, text: 'World' }]
```

---

## @sozai/async

Async primitives for deferred resolution, lazy evaluation, resource lifecycle, and cancellation.

### Exports

| Export | Kind | Description |
|---|---|---|
| `defer` | function | Create a `Deferred<T>` — an externally resolvable/rejectable promise |
| `lazy` | function | Wrap an async factory; runs once on first `await`, caches the result |
| `toPromise` | function | Coerce a value or sync-throwing function into a `Promise` |
| `raceSignal` | function | Race a promise against an `AbortSignal`; rejects with the signal reason on abort |
| `sleep` | function | Promise that resolves after a given number of milliseconds |
| `Deferred` | type | `{ promise, resolve, reject }` |
| `LazyPromise` | type | A `PromiseLike<T>` that defers execution until first `await` |
| `Disposer` | class | Extends `AbortController` + implements `AsyncDisposable`; aborts its signal on `dispose()` |
| `ScheduledTimeout` | class | Timeout that aborts a signal after a delay; cancel with `.cancel()` |
| `Interruption` | class | Base class for structured interruption errors |
| `AbortInterruption` | class | Interruption representing an external abort |
| `CancelInterruption` | class | Interruption representing a user-initiated cancel |
| `DisposeInterruption` | class | Interruption representing resource disposal |
| `TimeoutInterruption` | class | Interruption representing an elapsed timeout |

### Example: deferred, lazy, and Disposer

```typescript
import { defer, lazy, Disposer } from '@sozai/async'

// Externally resolved promise
const { promise, resolve } = defer<string>()
setTimeout(() => resolve('done'), 500)
const value = await promise // 'done'

// Lazy: factory runs exactly once on first await
let runs = 0
const lazyTask = lazy(async () => {
  runs++
  return 'computed'
})
console.log(runs)            // 0 — not yet run
await lazyTask               // 'computed'; runs === 1
await lazyTask               // 'computed'; runs still 1

// Disposer: AbortController + AsyncDisposable
const disposer = new Disposer({
  dispose: async (reason) => {
    console.log('cleanup:', reason)
  }
})

// Tie an async operation to the disposer's signal
fetch('/api/data', { signal: disposer.signal })

// Later: clean up (aborts signal, calls dispose callback)
await disposer.dispose('user cancelled')
// logs: 'cleanup: user cancelled'

// Or with `await using` (explicit resource management)
{
  await using d = new Disposer({ dispose: async () => closeDB() })
  // d.signal is live; block exit calls dispose automatically
}
```

---

## @sozai/event

Typed event emitter with built-in stream bridging. A custom, lightweight implementation (not based on an external library).

### Exports

| Export | Kind | Description |
|---|---|---|
| `EventEmitter` | class | Typed emitter: `on`, `once`, `emit`, `readable`, `writable` |
| `UnsubscribeFunction` | type | `() => void` returned by `on` |
| `ListenerOptions` | type | `{ filter?, signal? }` for `on` / `readable` |
| `DatalessEventNames` | type | Union of event names whose payload type is `void` |

### Methods on `EventEmitter<Events>`

| Method | Description |
|---|---|
| `on(name, listener, options?)` | Subscribe; returns `UnsubscribeFunction` |
| `once(name, options?)` | Returns a `Promise` that resolves on the next matching event |
| `emit(name, data?)` | Emit to all listeners; awaits and rethrows listener failures |
| `readable(name, options?)` | Bridge: events → `ReadableStream`; closes when `signal` aborts or stream is cancelled |
| `writable(name)` | Bridge: `WritableStream` → events; each written chunk calls `emit` |

### Example: typed emitter and stream bridge

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

---

## @sozai/flow

Async-generator state machine. Define typed handler functions and iterate through state transitions.

### Exports

| Export | Kind | Description |
|---|---|---|
| `createFlow` | function | Create a flow factory from a handlers record |
| `createGenerator` | function | Lower-level: create an async generator from an initial action and handlers |
| `FlowGenerator` | type | The async generator returned by a flow factory |
| `FlowAction` | type | `{ name: string; params?: unknown }` — an action to dispatch |
| `Handler` | type | A single handler function `(ctx) => FlowResult` |
| `HandlersRecord` | type | Map of action name → `Handler` |
| `HandlerExecutionContext` | type | `{ state: S; params: P }` passed to each handler |
| `GeneratorValue` | type | A non-terminal value yielded by the flow |
| `GeneratorDoneValue` | type | The terminal value yielded when `status: 'end'` |
| `MissingHandlerError` | class | Thrown when an action name has no registered handler |

### Example: state machine with `createFlow`

```typescript
import { createFlow } from '@sozai/flow'
import type { HandlerExecutionContext } from '@sozai/flow'

type AppState = { count: number; status: 'idle' | 'processing' | 'complete' }
type IncrementParams = { amount: number }

const handlers = {
  increment: ({ state, params }: HandlerExecutionContext<AppState, IncrementParams>) => {
    const newCount = state.count + params.amount
    if (newCount >= 10) {
      return {
        status: 'action' as const,
        state: { ...state, count: newCount, status: 'processing' as const },
        action: 'complete',
        params: { final: true },
      }
    }
    return { status: 'state' as const, state: { ...state, count: newCount } }
  },
  complete: ({ state }: HandlerExecutionContext<AppState, { final: boolean }>) => ({
    status: 'end' as const,
    state: { ...state, status: 'complete' as const },
  }),
}

const generateFlow = createFlow({ handlers })

const flow = generateFlow({
  state: { count: 0, status: 'idle' },
  action: { name: 'increment', params: { amount: 5 } },
})

for await (const value of flow) {
  if (value.status === 'state') {
    // dispatch next action
    await flow.next({ action: { name: 'increment', params: { amount: 6 } } })
  }
}
// terminal value: { status: 'end', state: { count: 11, status: 'complete' } }
```

---

## @sozai/generator

Utilities that bridge `EventEmitter` instances and `ReadableStream`s into typed async generators. Depends on `@sozai/async` and `@sozai/event`.

### Exports

| Export | Kind | Description |
|---|---|---|
| `consume` | function | Drive an `AsyncIterator<T>` to completion, calling a callback for each value; respects `AbortSignal`; returns `Promise<TReturn>` resolving to the iterator's return value |
| `fromEmitter` | function | Return an `AsyncGenerator` that yields events from an `EventEmitter` channel; supports `filter` and `AbortSignal` |
| `fromStream` | function | Return an `AsyncGenerator` that yields chunks from a `ReadableStream`; cancels the stream on early exit unless `preventCancel` is set |

### Example: consuming an event stream as an async generator

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

### Example: consuming a ReadableStream as an async generator

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

---

## @sozai/execution

Chainable, cancellable async execution with structured result handling. `Execution<V, E>` extends `AsyncResult<V, E | Interruption>` and implements `AbortController` and `AsyncDisposable`.

### Exports

| Export | Kind | Description |
|---|---|---|
| `Execution` | class | Core class — wraps an executable, exposes chain/abort/cancel/iterate APIs |
| `Executable` | type | `ExecuteFn \| ExecuteContext \| PromiseLike<ExecuteFn> \| PromiseLike<ExecuteContext>` — anything `Execution` can run |
| `ExecuteContext` | type | `{ execute, cleanup?, signal?, timeout? }` — the fully-resolved form of an executable |
| `ExecutionResult` | type | Union of `V`, `Promise<V>`, `Result<V, E \| Interruption>`, or `AsyncResult<…>` |
| `ExecuteFn` | type | `(signal: AbortSignal) => ExecutionResult<V, E>` |
| `NextFn` | type | `(result: Result<V, …>) => Executable<…> \| null` — produces the next step in a chain |

### Methods and properties on `Execution<V, E>`

| Member | Kind | Description |
|---|---|---|
| `next(fn)` | method | Chain: run `fn` with the current result; skip if `fn` returns `null` |
| `ifOK(fn)` | method | Chain only when the result is OK (successful) |
| `ifError(fn)` | method | Chain only when the result is an error or interruption |
| `execute()` | method | Trigger and await execution; returns `Promise<Result<V, E \| Interruption>>` |
| `generate()` | method | Return an `AsyncGenerator<Result<V, E \| Interruption>>` that yields a `Result` for each step of the chain (contrast `.value`, which unwraps the final OK value) |
| `abort(reason?)` | method | Abort the execution (and all previous in chain) with an optional reason |
| `cancel(cause?)` | method | Abort with a `CancelInterruption` |
| `isAborted` | getter | `true` if the signal has been aborted |
| `isInterrupted` | getter | `true` if aborted with any `Interruption` |
| `isCanceled` | getter | `true` if aborted with a `CancelInterruption` |
| `isDisposed` | getter | `true` if aborted with a `DisposeInterruption` |
| `isTimedOut` | getter | `true` if aborted with a `TimeoutInterruption` |
| `signal` | getter | The active `AbortSignal` for this execution |
| `value` | getter | `Promise<V>` — unwraps the OK value; rejects on error |
| `optional` | getter | `Promise<Option<V>>` |
| `orNull` | getter | `Promise<V \| null>` |
| `or(default)` | method | `Promise<V>` — returns `default` on error |

### Example: chained execution with error handling and cancellation

```typescript
import { Execution } from '@sozai/execution'

// Wrap an async operation
const fetchUser = new Execution(async (signal) => {
  const res = await fetch('/api/user/42', { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<{ id: number; name: string }>
})

// Chain: if OK, fetch their posts
const fetchPosts = fetchUser.ifOK((user) =>
  async (signal) => {
    const res = await fetch(`/api/user/${user.id}/posts`, { signal })
    return res.json() as Promise<Array<{ title: string }>>
  },
)

// Handle errors
const handled = fetchPosts.ifError((err) => {
  console.error('failed:', err.message)
  return null // no recovery step; propagate the error result
})

const result = await handled.execute()
if (result.isOK()) {
  console.log('posts:', result.value)
} else {
  console.error('error:', result.error.message)
}

// Cancellation
const long = new Execution(async (signal) => heavyWork(signal))
long.cancel('user navigated away')
console.log(long.isCanceled) // true
```

---

## When to Use

| Package | When to reach for it |
|---|---|
| `@sozai/stream` | Building data transformation pipelines with the Web Streams API; encoding/decoding NDJSON; creating bidirectional stream pairs |
| `@sozai/async` | Deferred promise resolution; lazy one-time async initialization; resource lifecycle and `await using` cleanup; structured cancellation/timeout |
| `@sozai/event` | Type-safe pub/sub within a module; bridging events to `ReadableStream` or vice-versa; filtering event-driven data flows |
| `@sozai/flow` | Multi-step state machines where each step can dispatch the next action; typed state transitions with handler validation |
| `@sozai/generator` | Consuming an event channel or `ReadableStream` with `for await` loops or a callback-driven consumer; driving an `AsyncIterator` to completion with abort support |
| `@sozai/execution` | Chainable async steps with structured `Result` handling; unified abort/cancel/timeout control across a sequence of operations; introspecting interruption type after the fact |
