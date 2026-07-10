# stream — test hardening follow-ups

**Status:** open · low priority · test-only
**Source:** minor findings from [stream-robustness completion](../completed/2026-07-09-stream-robustness.complete.md)

Non-blocking coverage and robustness gaps left by the stream-robustness work. All the underlying
behaviour was verified correct by review and inspection; these harden the tests against future
regressions. None affects shipped behaviour.

- **Pin `readable.cancel()` with no argument.** Cancelling with no reason sets `failure` to
  `{ reason: undefined }`, so the peer's next write/close rejects with `undefined` — correct verbatim
  pass-through, but a "simplification" of the `failure ??= { reason }` sentinel to `??= reason` would
  silently regress it. No test covers this case. Add one in `packages/stream/test/pipe.test.ts`.

- **Replace timing-based non-settlement assertions.** The backpressure/park tests in
  `packages/stream/test/pipe.test.ts` and `packages/stream/test/connection.test.ts` prove a promise
  has *not* settled by awaiting a real 10ms `setTimeout`. Correct but a latent flake source under
  load. A microtask-flush helper (or a small deterministic scheduler) would be sturdier.

- **Exercise `createConnection` backpressure in both directions.** The `highWaterMark` test only
  drives the client→server channel. The reverse reuses the identical `createChannel`, so risk is
  low, but a symmetric assertion closes the gap.

- **Assert call counts on the json-lines corrupt-line tests.** The unbalanced-bracket and
  raw-newline tests in `packages/stream/test/json-lines.test.ts` assert the `onInvalidJSON` argument
  but not how many times it fired. A regression that double-reported a corrupt line would slip past.
  Add `toHaveBeenCalledTimes` where the expected count is deterministic (note: the raw-newline test
  legitimately fires twice — once per framed line — so document that rather than asserting once).
