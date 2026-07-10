# stream — test hardening follow-ups

**Status:** done · test-only
**Source:** minor findings from [stream-robustness completion](../completed/2026-07-09-stream-robustness.complete.md)

Non-blocking coverage and robustness gaps left by the stream-robustness work. All the underlying
behaviour was verified correct by review and inspection; these harden the tests against future
regressions. None affected shipped behaviour. All four addressed on branch `stream-robustness`
(50 tests passing, `test:types` and biome clean).

- **[done] Pin `readable.cancel()` with no argument.** Cancelling with no reason sets `failure` to
  `{ reason: undefined }`, so the peer's next write/close rejects with `undefined` — correct verbatim
  pass-through, but a "simplification" of the `failure ??= { reason }` sentinel to `??= reason` would
  silently regress it. Covered by "cancel with no reason rejects the next write with undefined" in
  `packages/stream/test/pipe.test.ts`.

- **[done] Replace timing-based non-settlement assertions.** The backpressure/park tests in
  `packages/stream/test/pipe.test.ts` and `packages/stream/test/connection.test.ts` proved a promise
  had *not* settled by awaiting a real 10ms `setTimeout` — a latent flake source. Both now use a
  shared `flushMicrotasks()` helper (drain queued microtasks; a parked write is released only by a
  real read, so a still-pending write has provably parked).

- **[done] Exercise `createConnection` backpressure in both directions.** The `highWaterMark` test
  only drove client→server. Added "highWaterMark parks the server-to-client direction too" in
  `packages/stream/test/connection.test.ts`.

- **[done] Assert call counts on the json-lines corrupt-line tests.** Added `toHaveBeenCalledTimes`
  to the corrupt-line tests in `packages/stream/test/json-lines.test.ts`. Empirically confirmed: the
  two raw-newline tests fire twice (offending line + trailing remnant framed as a second line); the
  mid-line-unbalance, multi-line stray-bracket, and single-line invalid tests fire once.
