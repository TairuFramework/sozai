# @sozai/async

Async primitives for deferred resolution, lazy evaluation, resource lifecycle, and cancellation.

## Exports

| Export | Kind | Description |
|---|---|---|
| `defer` | function | Create a `Deferred<T>` — an externally resolvable/rejectable promise |
| `lazy` | function | Wrap an async factory into a `LazyPromise`; runs once on first `await`, caches the result |
| `toPromise` | function | Run a function (that may throw synchronously) and return its result as a `Promise` |
| `raceSignal` | function | Race a promise against an `AbortSignal`; rejects with the signal reason on abort |
| `sleep` | function | Promise that resolves after a given number of milliseconds |
| `onAbort` | function | Register a self-cleaning abort listener; fires synchronously if the signal is already aborted |
| `isBenignTeardownError` | function | `true` for errors that represent a peer- or local-teardown signal rather than a real failure |
| `Deferred` | type | `{ promise, resolve, reject }` |
| `LazyPromise` | class | A `Promise<T>` subclass that defers running its executor until first `await` |
| `Disposer` | class | Extends `AbortController` + implements `AsyncDisposable`; aborts its signal on `dispose()`. Params: `dispose?`, `onDisposeError?`, `signal?` (tie disposal to an external `AbortSignal`) |
| `ScheduledTimeout` | class | Timeout that aborts a signal after a delay; cancel with `.cancel()` |
| `Interruption` | class | Base class for structured interruption errors |
| `AbortInterruption` | class | Interruption representing an external abort |
| `CancelInterruption` | class | Interruption representing a user-initiated cancel |
| `DisposeInterruption` | class | Interruption representing resource disposal |
| `TimeoutInterruption` | class | Interruption representing an elapsed timeout |

These four `Interruption` subclasses are what `@sozai/execution`'s `isCanceled` / `isDisposed` /
`isTimedOut` getters distinguish between.

## Example: deferred, lazy, and Disposer

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
