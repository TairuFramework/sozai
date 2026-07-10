# stream — abort/cancel/backpressure propagation + json-lines recovery

**Status:** complete
**Date:** 2026-07-09
**Package:** `@sozai/stream`
**Source:** [audit 2026-07-02 — stream](2026-07-02-repo-audit.complete.md#stream)

Closed the `stream` freeze-blocker from the 2026-07-02 audit: the transport primitives had no
abort/cancel/backpressure propagation, and the json-lines framer could wedge permanently. This
layer carries RPC framing for `enkaku`, so a wedged framer silently dropped messages.

## What was built

**Transport primitives.** Extracted an internal half-duplex `createChannel` primitive
(`src/channel.ts`, not exported from the package) that carries the abort, cancel, backpressure,
and close-guard semantics in one place. `createPipe` became one channel plus `drain`;
`createConnection` became two channels crossed. Behaviour delivered:

- Aborting a writable errors the peer readable with the same reason, so a parked `read()` rejects
  instead of hanging forever holding the reader lock.
- Cancelling a readable makes the peer's next `write`/`close` reject with the cancel reason,
  instead of an opaque `TypeError` from a detached controller.
- Opt-in backpressure via a `highWaterMark` option on both factories. When omitted, the queue
  grows unbounded and writes resolve immediately — byte-for-byte the `0.1.0` contract, which
  `createPipe`'s "queue until read" promise and `enkaku`'s write-before-read server handlers rely
  on. Honouring `desiredSize` unconditionally would have deadlocked those call sites.
- `drain()` followed by `writer.close()` resolves instead of rejecting (the controller close is
  now idempotent).

**json-lines framer** (`src/json-lines.ts`):

- A stray `]` or `}` line no longer drives `nestingDepth` negative forever. It now costs exactly
  one message: the offending text routes to `onInvalidJSON`, the framer resets, and framing
  resumes at the next newline. This was the core freeze-blocker.
- A raw newline inside a string literal is rejected as invalid JSON (routed to `onInvalidJSON`)
  rather than "repaired" by fabricating escape content that never arrived on the wire. Removing
  that repair path also removed a stale-`isEscapingChar` bug that fired when a buffered string
  ended in a backslash. A message left truncated mid-string or mid-object at end of input reports
  as invalid too, rather than being silently dropped.
- Whitespace is retained in the message buffer (`JSON.parse` accepts it), so `onInvalidJSON`
  receives the text as transmitted rather than a stripped reconstruction.
- `decode` retyped from `DecodeJSON<unknown>` to `DecodeJSON<T>`, moving an unsound cast out of the
  library and onto the caller who supplies a custom `decode`.

## Key design decisions

- **Backpressure is opt-in with an unbounded default.** A frozen API keeps the knob forever, and
  the default can never deadlock a downstream consumer. Enabling it by default would have silently
  wedged every write-before-read caller.
- **Abort/cancel reasons pass through verbatim.** No new exported error types; a caller's
  `AbortSignal.reason` or custom error reaches the peer unwrapped. A `WritableStream` cannot be
  errored from outside without its writer lock, so a readable's cancel reason crosses to the
  writable through an internal `failure` slot that the sink callbacks throw.
- **Framing corruption is not a stream error.** It routes to `onInvalidJSON` and the stream stays
  live. A transport that dies on one malformed peer message is worse than one that drops it.
  `JSONLinesError` remains confined to size-limit violations and encode failures.
- **`maxMessageSize` now measures the message as transmitted** (whitespace included), an accepted
  consequence of retaining whitespace. `enkaku` forwards no custom size limits, so no consumer is
  affected.

## Two non-obvious implementation facts (worth preserving)

- **Backpressure parks before `enqueue`, not after.** A `ReadableStream` at `highWaterMark: 2`
  starts with `desiredSize === 2`; parking after the enqueue would block the second write, but the
  contract is that the third write parks.
- **A parked write cannot be rescued by the sink's `abort` callback.** Per the WHATWG Streams spec,
  `WritableStreamStartErroring` defers the sink `abort` callback until the in-flight write settles,
  so `writer.abort()` would deadlock against its own parked write. The escape hatch is the
  `WritableStreamDefaultController.signal`, aborted synchronously; the parked write races its
  capacity deferred against that signal via `@sozai/async`'s `onAbort`.

## Downstream impact

Every public signature stayed call-compatible: new arguments are optional and every current default
reproduces `0.1.0` behaviour. `enkaku` calls `createPipe`, `createConnection`, `fromJSONLines`,
`createReadable`, and `writeTo` across six packages, all with zero or forwarded options — no
coordinated release required. No changeset was written here; the release-version decision belongs to
the `infra-license-and-versioning` freeze-blocker.

## Process notes

Executed subagent-driven: fresh implementer per task, a spec+quality review after each, and a broad
whole-branch review at the end. The review loop caught four real defects, three of them in the plan
itself rather than the implementations:

- A whitespace leak: ignored blank lines left their characters in the buffer to be prepended to the
  next message, corrupting `onInvalidJSON`'s reported text and making `maxMessageSize` reject
  otherwise-valid messages. The plan's prescribed code had the bug; fixed across three tasks.
- A type-inference test that proved nothing: WHATWG streams declare `read`/`write` with method
  syntax, so their parameters are checked bivariantly and a `pipeTo` into a typed sink accepts
  `unknown` silently. Replaced with a conditional-`infer` extraction of the output element type.
- The final whole-branch review found one Critical that no per-task review could see, because it
  spanned tasks: `close()` did not settle a write parked on backpressure (only `cancel`/`abort`
  did), so `drain()` racing a parked write hung it forever and lost its message. Fixed to reject the
  parked write — resolving would re-park it against a closed controller whose `desiredSize` is `0`.

Landed on branch `stream-robustness`, 19 commits above `main`. Final state: 50 tests passing across
5 files, `tsc` and `biome` clean.

## Follow-on

A round of test-hardening followed the core work and is complete — all test-only, no shipped
behaviour changed:

- **`readable.cancel()` with no argument is pinned.** Cancelling with no reason sets the internal
  `failure` slot to `{ reason: undefined }`, so the peer's next write rejects with `undefined`
  verbatim. A test now guards this against a `failure ??= reason` simplification that would regress
  it to a hang.
- **Timing-based non-settlement assertions removed.** The backpressure/park tests proved a promise
  had *not* settled by awaiting a real 10ms `setTimeout` (a latent flake); they now use a
  deterministic `flushMicrotasks()` helper — a parked write is released only by a real read, so
  after the flush a still-pending write has provably parked.
- **`createConnection` backpressure asserted in both directions.** The reverse (server→client)
  channel reuses the same `createChannel`, but a symmetric assertion now closes the gap.
- **Call counts asserted on the json-lines corrupt-line tests.** The two raw-newline cases fire
  `onInvalidJSON` twice (offending line plus the trailing remnant framed as a second line); the
  mid-line-unbalance, multi-line stray-bracket, and single-line invalid cases fire once. Counts
  confirmed empirically.
