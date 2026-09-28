---
'@sozai/async': minor
---

Add retry policy helpers: `retry`, `raceAttempt`, `getRetryDelay`, `assertRetryPolicy`, `RetryExhaustedError` and `MAX_DELAY_MS`, with the `RetryPolicy`, `RetryBackoff` and `RetryDecision` types.

Attempt timeouts and the total deadline are enforced by racing the attempt, so an attempt that ignores its signal still times out. All deadline arithmetic uses an injectable `now()` clock.

`sleep(delay, signal?)` now takes an optional abort signal. Aborting rejects with `signal.reason` and clears the timer.
