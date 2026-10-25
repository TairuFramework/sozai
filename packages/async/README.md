# @sozai/async

Async primitives: deferred promises, lazy evaluation, disposable resources, and structured interruptions.

## Installation

```sh
pnpm add @sozai/async
```

## Usage

```ts
import { defer, lazy, Disposer } from '@sozai/async'

// `defer` — an externally resolvable promise
const { promise, resolve } = defer<string>()
setTimeout(() => resolve('done'), 500)
await promise // 'done'

// `lazy` — the factory runs once, on first await, and caches the result
const task = lazy(async () => 'computed')
await task // runs the factory
await task // cached; factory not called again

// `Disposer` — an AbortController that is also an AsyncDisposable
await using resource = new Disposer({
  dispose: async (reason) => {
    /* release the resource */
  },
})
fetch('/api', { signal: resource.signal }) // tie work to the disposer's signal
// leaving the block aborts the signal and runs `dispose`
```

Also provides `sleep` (optionally abortable), `raceSignal` (race a promise against an `AbortSignal`), `ScheduledTimeout`,
and a structured `Interruption` hierarchy (`AbortInterruption`, `CancelInterruption`,
`DisposeInterruption`, `TimeoutInterruption`) for distinguishing why an operation stopped.

Retry utilities include `RetryBackoff`, `RetryPolicy`, and `RetryDecision`, plus
`getRetryDelay()` for policy delay calculations, `raceAttempt()` for enforcing attempt timeouts
and deadlines, and `retry()` for running a retry loop. `assertRetryPolicy()` validates policy
bounds, `MAX_DELAY_MS` is the maximum supported delay, and exhausted loops reject with
`RetryExhaustedError`.

Cooperative scheduling: `createYielder({ budgetMs?, now? })` returns a `Yielder` whose
`maybeYield()` long async loops call between units of work. It resolves immediately while a
macrotask turn happened within the budget (default `DEFAULT_YIELD_BUDGET_MS`, 8 ms), otherwise
waits for a `setTimeout(…, 0)` turn; queued waiters resume one per turn in FIFO order. The shared
`defaultYielder` (and its `maybeYield()`) lets independent libraries cooperate on one clock.
