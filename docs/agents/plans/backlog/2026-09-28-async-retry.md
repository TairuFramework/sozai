# async — retry policy and helpers

**Status:** open · requested by mokei · prerequisite of `2026-09-28-flow-graph-package.md`
**Package:** `@sozai/async`

## Why

`@sozai/flow-graph` needs retries with timeouts and backoff for nodes calling external APIs (LLMs,
System One, HTTP). No retry helper exists in the stack. The policy shape and delay computation are
general-purpose, so they belong in `@sozai/async` next to `sleep`, `raceSignal` and
`TimeoutInterruption`, not in the flow engine.

## Scope

```ts
export type RetryBackoff = {
  initialMs: number
  multiplier?: number      // default 2
  maxMs?: number           // cap per wait
  jitter?: boolean         // full jitter: uniform in [0, delay]
}

export type RetryPolicy = {
  maxAttempts: number      // including the first attempt; 1 means no retry
  attemptTimeoutMs?: number
  totalTimeoutMs?: number  // across attempts and waits
  backoff?: RetryBackoff   // absent: retry immediately
}

/** `true` retry with backoff, `false` stop, `{ afterMs }` retry after at least this delay. */
export type RetryDecision = boolean | { afterMs: number }

/** Delay before the attempt following `attempt` (1-based). Pure. */
export function getRetryDelay(
  policy: RetryPolicy,
  attempt: number,
  params?: { afterMs?: number; random?: () => number },
): number

export type RetryParams = {
  policy: RetryPolicy
  signal?: AbortSignal
  retryable?: (error: unknown) => RetryDecision  // default: retry TimeoutInterruption only
  onRetry?: (event: { attempt: number; delayMs: number; error: unknown }) => void
  random?: () => number                          // default Math.random; injectable for tests
  now?: () => number                             // epoch ms; default Date.now; injectable for tests
}

export function retry<T>(
  fn: (ctx: { attempt: number; signal: AbortSignal }) => Promise<T>,
  params: RetryParams,
): Promise<T>

export class RetryExhaustedError extends Error {
  attempts: number         // `cause` carries the last error
  reason: 'attempts' | 'total_timeout'
}

/** Run one attempt, racing it against its timeout and deadline. Shared with @sozai/flow-graph. */
export function raceAttempt<T>(params: {
  fn: (signal: AbortSignal) => Promise<T>
  signal?: AbortSignal     // caller abort
  timeoutMs?: number       // per-attempt timeout
  deadline?: number        // absolute epoch ms (total timeout)
  now?: () => number       // epoch ms clock used to compute the remaining time to `deadline`
}): Promise<T>

/** Validate a policy against the bounds below; throws RangeError naming the field. */
export function assertRetryPolicy(policy: RetryPolicy): void

export const MAX_DELAY_MS = 2_147_483_647   // setTimeout limit
```

### Bounds

- `maxAttempts`: integer, 1 to 100.
- `attemptTimeoutMs`, `totalTimeoutMs`, `initialMs`, `maxMs`: finite integers, 0 to `MAX_DELAY_MS`.
- `multiplier`: finite, ≥ 1.
- `afterMs` (from `RetryDecision`): clamped to [0, `MAX_DELAY_MS`]; non-finite treated as absent.
- Computed delays are clamped to `MAX_DELAY_MS`; exponent overflow saturates, never `Infinity`.
- `retry()` and `getRetryDelay()` call `assertRetryPolicy`.

### Clock

All deadline arithmetic uses the injected `now()` (epoch milliseconds, default `Date.now`), never
`Date.now()` directly. Timers are still real `setTimeout`s; tests combine an injected `now` with
fake timers. Deadlines are absolute epoch ms so they can be persisted and compared across processes
(the caller owns clock agreement between hosts).

### Semantics

- Delay: `min(initialMs * multiplier^(attempt - 1), maxMs)`, then full jitter when enabled, then
  `max(result, afterMs)` so a server hint (e.g. `Retry-After`) is never shortened by jitter.
- **Timeouts enforce, not just signal.** `raceAttempt` passes the attempt a signal combining caller
  abort, the attempt timeout and the deadline, **and** races the attempt promise against them. When
  the timeout or deadline fires first, `raceAttempt` rejects immediately with `TimeoutInterruption`
  (`cause`: `'attempt'` or `'deadline'` in the message options), even if `fn` ignores its signal.
  A late resolution or rejection of the abandoned attempt is ignored (its rejection is caught so it
  never surfaces as unhandled).
- The default `retryable` retries a `TimeoutInterruption` from the attempt timeout, not from the
  deadline.
- Caller abort stops immediately: the in-flight attempt sees the aborted signal, the race and waits
  are cut short, and `retry` rejects with `signal.reason`. Never retried, never wrapped.
- `totalTimeoutMs`: an absolute deadline taken when `retry` starts. It bounds every attempt through
  `raceAttempt`. A wait that would end past it is not started. Both cases reject with
  `RetryExhaustedError` (`reason: 'total_timeout'`).
- Non-retryable error: rethrown as-is (not wrapped), so callers keep their error classes.
- Attempts exhausted: `RetryExhaustedError` with `attempts` and `cause`.
- `onRetry` fires before each wait; exceptions from it propagate.

### Related change

`sleep(delay, signal?)`: optional signal; abort rejects with `signal.reason` and clears the timer.
Backward compatible.

## Consumers

- `@sozai/flow-graph` uses `RetryPolicy`, `RetryDecision`, `getRetryDelay`, `raceAttempt` and
  `assertRetryPolicy`, but drives the loop itself: it persists attempt counts in its run state
  between tries and may suspend a run instead of sleeping through a long wait. `retry()` is not
  usable there as-is.
- Later: `@mokei/system-one-client`'s HTTP backend could adopt `retry()` with `retryAfterMs`.

## Testing

- `getRetryDelay`: exponential growth, cap, jitter bounds with injected `random`, `afterMs` floor,
  overflow saturation, `afterMs` clamping.
- `assertRetryPolicy`: each bound, with the field named in the error.
- `raceAttempt`: attempt ignoring its signal still times out; late resolution and late rejection
  ignored without unhandled rejections; deadline vs attempt timeout distinguished.
- `retry`: success first try; retry then success; exhausted; non-retryable rethrown unwrapped;
  `{ afterMs }` honoured; attempt timeout yields `TimeoutInterruption` and is retried; caller abort
  during attempt and during wait; `totalTimeoutMs`; `onRetry` events. Fake timers throughout.
- `sleep` with signal: abort before and during.
