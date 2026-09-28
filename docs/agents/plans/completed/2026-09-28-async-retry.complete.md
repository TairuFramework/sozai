# async -- retry policy and helpers

**Status:** complete
**Date:** 2026-09-28
**Packages:** `@sozai/async` (minor intent, from 0.2.1)
**Requested by:** mokei, as the prerequisite of `@sozai/flow-graph`

## Why

`@sozai/flow-graph` needs retries with timeouts and backoff for nodes that call external APIs.
No retry helper existed in the stack. The policy shape and the delay computation are general, so
they live in `@sozai/async` next to `sleep`, `raceSignal` and `TimeoutInterruption`.

## Key design decisions

**Timeouts enforce, not just signal.** `raceAttempt` gives the attempt a signal combining caller
abort, the attempt timeout and the deadline, and it also races the attempt promise. An attempt that
ignores its signal still rejects on time with `TimeoutInterruption`. Its `cause` is `'attempt'` or
`'deadline'`. A late settlement of the abandoned attempt is caught and ignored. When the deadline
has already passed at call time, `raceAttempt` rejects without calling the attempt.

**The default `retryable` retries attempt timeouts only.** A deadline timeout is never retried:
it ends `retry` with `RetryExhaustedError` (`reason: 'total_timeout'`). Other errors are rethrown
unwrapped, so callers keep their error classes. Caller abort rejects with `signal.reason`, never
wrapped and never retried.

**Delays are pure and bounded.** `getRetryDelay` computes
`min(initialMs * multiplier^(attempt - 1), maxMs)`, applies full jitter, then floors the result at
`afterMs`, so a server `Retry-After` hint is never shortened by jitter. Every delay is clamped to
`MAX_DELAY_MS` (the `setTimeout` limit), and exponent overflow saturates instead of reaching
`Infinity`. `assertRetryPolicy` validates every bound and names the field in its `RangeError`.

**Injected clock.** All deadline arithmetic uses `now()` (epoch milliseconds, default `Date.now`).
Deadlines are absolute epoch milliseconds, so `@sozai/flow-graph` can persist them and compare
them across processes.

**A wait that would pass the deadline is not started.** `retry` ends with `total_timeout` instead.
`onRetry` fires only for a wait that will actually happen.

## What was built

`retry`, `raceAttempt`, `getRetryDelay`, `assertRetryPolicy`, `RetryExhaustedError` (with
`attempts` and `reason` getters, the last error as `cause`), `MAX_DELAY_MS`, and the
`RetryPolicy`, `RetryBackoff`, `RetryDecision` and `RetryParams` types. `sleep(delay, signal?)`
takes an optional abort signal: abort rejects with `signal.reason` and clears the timer. The change
is backward compatible.

157 tests in `@sozai/async`, all with fake timers and an injected clock.

## Consumers

- `@sozai/flow-graph` uses the policy types, `getRetryDelay`, `raceAttempt` and
  `assertRetryPolicy`, but drives its own loop so it can persist attempt counts and suspend long
  waits. See [flow-graph](./2026-09-28-flow-graph-package.complete.md).
- Later: `@mokei/system-one-client` could adopt `retry()` for its HTTP backend.
