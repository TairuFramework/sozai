# @sozai/execution

Chainable, cancellable async execution with structured result handling. `Execution<V, E>` extends `AsyncResult<V, E | Interruption>` and implements `AbortController`, `AsyncDisposable`, and `AsyncIterable` (so `for await` over an `Execution` works the same as `.generate()`).

## Exports

| Export | Kind | Description |
|---|---|---|
| `Execution` | class | Core class — wraps an executable, exposes chain/abort/cancel/iterate APIs. Constructor: `new Execution(executable, { signal?, timeout? })`; the optional context bounds the whole chain, not just one step |
| `Executable` | type | `ExecuteFn \| ExecuteContext \| PromiseLike<ExecuteFn> \| PromiseLike<ExecuteContext>` — anything `Execution` can run |
| `ExecuteContext` | type | `{ execute, cleanup?, signal?, timeout? }` — the fully-resolved form of an executable |
| `ExecutionResult` | type | Union of `V`, `Promise<V>`, `Result<V, E \| Interruption>`, or `AsyncResult<…>` |
| `ExecuteFn` | type | `(signal: AbortSignal) => ExecutionResult<V, E>` |
| `NextFn` | type | `(result: Result<V, …>) => Executable<…> \| null` — produces the next step in a chain |

Construction is lazy: nothing runs until the `Execution` is awaited or `.execute()` is called,
even after chaining `.next()` / `.ifOK()` / `.ifError()`.

## Methods and properties on `Execution<V, E>`

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

## Example: chained execution with error handling and cancellation

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
console.log(long.isCanceled)    // true
console.log(long.isInterrupted) // true — CancelInterruption is an Interruption
```
