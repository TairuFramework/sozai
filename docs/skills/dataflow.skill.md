---
name: sozai:dataflow
description: Streaming, async, events, generators, and stateful flow patterns
---

# Sozai Dataflow

Six packages for building async data pipelines in the sozai layer: stream processing, async primitives, typed events, generator utilities, stateful flow execution, and chainable execution control.

## Packages in This Domain

| Package | One-liner |
|---|---|
| `@sozai/stream` | Web Streams creation, transformation, JSON Lines |
| `@sozai/async` | Deferred promises, lazy eval, Disposer, interruptions |
| `@sozai/event` | Typed event emitter with stream bridging |
| `@sozai/flow` | Async-generator state machine |
| `@sozai/generator` | Emitter/stream → async generator adapters |
| `@sozai/execution` | Chainable, cancellable async execution with Result |

---

## Key Patterns

### Pattern 1: Web Streams Transformation Pipeline

```typescript
import { createReadable, createArraySink, tap, map, mapAsync } from '@sozai/stream'

const [source, controller] = createReadable<number>()
const [sink, result] = createArraySink<string>()

source
  .pipeThrough(tap((n) => console.log('Processing:', n)))
  .pipeThrough(map((n) => n * 2))
  .pipeThrough(mapAsync(async (n) => `Value: ${n}`))
  .pipeTo(sink)

controller.enqueue(1)
controller.enqueue(2)
controller.enqueue(3)
controller.close()

// result resolves to ['Value: 2', 'Value: 4', 'Value: 6']
```

Built on the Web Streams API — works in browsers, Node.js, Deno, and Bun. Composable transforms (`map`, `mapAsync`, `tap`) with automatic backpressure.

### Pattern 2: JSON Lines (NDJSON) Streaming

```typescript
import { createReadable, createArraySink, toJSONLines, fromJSONLines } from '@sozai/stream'

type Msg = { id: number; text: string }

// Encode objects → NDJSON
const [src, ctrl] = createReadable<Msg>()
const [sink, lines] = createArraySink<string>()
src.pipeThrough(toJSONLines()).pipeTo(sink)
ctrl.enqueue({ id: 1, text: 'Hello' })
ctrl.close()
// lines → ['{"id":1,"text":"Hello"}\n']

// Decode NDJSON → objects
const [jsonSrc, jsonCtrl] = createReadable<string>()
const [objSink, msgs] = createArraySink<Msg>()
jsonSrc.pipeThrough(fromJSONLines<Msg>()).pipeTo(objSink)
jsonCtrl.enqueue('{"id":1,"text":"Hello"}\n')
jsonCtrl.close()
// msgs → [{ id: 1, text: 'Hello' }]
```

Handles chunked data and buffering automatically. Parse errors surfaced via `JSONLinesError`.

### Pattern 3: Event-Driven Streams

```typescript
import { EventEmitter } from '@sozai/event'
import { createArraySink } from '@sozai/stream'

type Events = { data: { value: number }; done: void }

const emitter = new EventEmitter<Events>()
const controller = new AbortController()

// Bridge a typed event channel to a ReadableStream
const stream = emitter.readable('data', {
  filter: (e) => e.value > 10,
  signal: controller.signal,
})

const [sink, results] = createArraySink<{ value: number }>()
stream.pipeTo(sink)

await emitter.emit('data', { value: 5 })   // filtered out
await emitter.emit('data', { value: 15 })  // included
await emitter.emit('data', { value: 20 })  // included

controller.abort()
// results resolves to [{ value: 15 }, { value: 20 }]
```

`EventEmitter` is a custom, lightweight, type-safe implementation. `readable()` converts an event channel to a `ReadableStream`; `writable()` does the inverse.

### Pattern 4: Async Resource Management

```typescript
import { defer, lazy, Disposer } from '@sozai/async'

// Externally resolved promise
const { promise, resolve } = defer<string>()
setTimeout(() => resolve('done'), 500)
await promise // 'done'

// Lazy: factory runs exactly once on first await
const lazyTask = lazy(async () => expensiveSetup())
await lazyTask // runs setup
await lazyTask // reuses cached result

// Disposer: AbortController + AsyncDisposable for resource cleanup
const disposer = new Disposer({
  dispose: async (reason) => {
    console.log('cleanup:', reason)
    await releaseResources()
  },
})

fetch('/api/data', { signal: disposer.signal })
await disposer.dispose('user cancelled')
// logs: 'cleanup: user cancelled'

// Or with explicit resource management syntax
{
  await using d = new Disposer({ dispose: async () => closeDB() })
  // d.signal aborted and dispose() called automatically on block exit
}
```

Interruption types (`AbortInterruption`, `CancelInterruption`, `DisposeInterruption`, `TimeoutInterruption`) integrate with `@sozai/execution`.

### Pattern 5: Stateful Flow Execution

```typescript
import { createFlow } from '@sozai/flow'
import type { HandlerExecutionContext } from '@sozai/flow'

type State = { count: number; status: 'idle' | 'processing' | 'complete' }
type IncrementParams = { amount: number }

const handlers = {
  increment: ({ state, params }: HandlerExecutionContext<State, IncrementParams>) => {
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
  complete: ({ state }: HandlerExecutionContext<State, { final: boolean }>) => ({
    status: 'end' as const,
    state: { ...state, status: 'complete' as const },
  }),
}

const generateFlow = createFlow({ handlers })
const flow = generateFlow({
  state: { count: 0, status: 'idle' },
  action: { name: 'increment', params: { amount: 5 } },
})

for await (const v of flow) {
  if (v.status === 'state') {
    await flow.next({ action: { name: 'increment', params: { amount: 6 } } })
  }
}
// terminal: { status: 'end', state: { count: 11, status: 'complete' } }
```

Each handler returns `{ status: 'state' | 'action' | 'end', state, action?, params? }`. Unknown action names throw `MissingHandlerError`. The generator implements `AsyncDisposable`.

### Pattern 6: Async Generator Adapters

```typescript
import { EventEmitter } from '@sozai/event'
import { fromEmitter, fromStream, consume } from '@sozai/generator'
import { createReadable } from '@sozai/stream'

type Events = { message: string }
const emitter = new EventEmitter<Events>()
const ac = new AbortController()

// fromEmitter: event channel → async generator
const messages = fromEmitter(emitter, 'message', { signal: ac.signal })

// consume: drive an AsyncIterator with a callback
const done = consume(messages, (msg) => console.log('got:', msg), ac.signal)

await emitter.emit('message', 'hello')  // logs 'got: hello'
ac.abort()
await done.catch(() => {})

// fromStream: ReadableStream → async generator
const [stream, ctrl] = createReadable<number>()
ctrl.enqueue(1); ctrl.enqueue(2); ctrl.close()

for await (const chunk of fromStream(stream)) {
  console.log(chunk) // 1, 2
}
```

`fromEmitter` and `fromStream` both implement `Symbol.asyncDispose` for cleanup. `consume` respects `AbortSignal` and calls `iterator.return()` on abort.

### Pattern 7: Chainable Execution

```typescript
import { Execution } from '@sozai/execution'

const fetchUser = new Execution(async (signal) => {
  const res = await fetch('/api/user/42', { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<{ id: number; name: string }>
})

const withPosts = fetchUser
  .ifOK((user) => async (signal) => {
    const res = await fetch(`/api/user/${user.id}/posts`, { signal })
    return res.json() as Promise<Array<{ title: string }>>
  })
  .ifError((err) => {
    console.error('fetch failed:', err.message)
    return null // propagate the error result unchanged
  })

const result = await withPosts.execute()
if (result.isOK()) {
  console.log(result.value)
} else {
  console.error(result.error.message)
}

// Cancellation
const long = new Execution((signal) => heavyWork(signal))
long.cancel('user navigated away')
console.log(long.isCanceled)   // true
console.log(long.isInterrupted) // true
```

`Execution` wraps any `ExecuteFn | ExecuteContext` and returns a chainable `AsyncResult`. Chain steps with `ifOK` / `ifError` / `next`; each step is lazy until `.execute()` is awaited. Integrates with `@sozai/async` interruption types for `isCanceled` / `isDisposed` / `isTimedOut` flags.

---

## When to Use

| Package | When to reach for it |
|---|---|
| `@sozai/stream` | Data transformation pipelines; Web Streams composition; NDJSON encode/decode |
| `@sozai/async` | Deferred promises; lazy one-time init; `await using` resource cleanup; structured cancellation |
| `@sozai/event` | Type-safe pub/sub; bridging events to streams; filtering event-driven data |
| `@sozai/flow` | Multi-step state machines; typed state transitions; dispatch-next-action workflows |
| `@sozai/generator` | `for await` over event channels or readable streams; callback-driven iterator consumption |
| `@sozai/execution` | Chainable async steps with `Result`; unified abort/cancel/timeout; introspecting interruption type |

---

## Related Domains

- `sozai:validation` — input validation layer, often used at flow handler boundaries
- `sozai:runtime` — environment-specific runtime hooks; dataflow packages are runtime-agnostic
- `sozai:observability` — metrics and tracing for long-running stream/execution pipelines
- `sozai:primitives` — base `Result`/`AsyncResult` types that `Execution` builds on

## Detailed Reference

`docs/reference/dataflow.md`
