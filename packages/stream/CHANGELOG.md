# @sozai/stream

## 0.2.0

### Minor Changes

- Add abort/cancel/backpressure propagation to the transport primitives and fix the json-lines framer wedge found in the 2026-07-02 audit. Every public signature stayed call-compatible — new arguments are optional and their defaults reproduce the `0.1.0` contract — but the propagation behaviour is new, so this is a minor bump.

  Transport primitives (`createPipe`, `createConnection`, both now built on one internal half-duplex channel):

  - **Aborting a writable errors the peer readable with the same reason.** A parked `read()` now rejects instead of hanging forever.
  - **Cancelling a readable makes the peer's next `write`/`close` reject** with the cancel reason.
  - **Opt-in backpressure via `highWaterMark`** on both factories. Omitted (the default) means an unbounded queue and writes that resolve immediately — byte-for-byte the `0.1.0` contract that write-before-read consumers rely on.
  - `drain()` followed by `writer.close()` resolves; controller close is idempotent.

  json-lines framer:

  - **A stray `]` or `}` no longer wedges the framer permanently.** The nesting depth could be driven negative and never recover, silently dropping every subsequent message. The offending line now routes to `onInvalidJSON`, the framer resets, and framing resumes. Framing corruption is not a stream error — `JSONLinesError` stays confined to size limits and encode failures.
  - **A raw newline inside a string literal is rejected as invalid** rather than "repaired" with escape content that never arrived.
  - Whitespace is retained in the message buffer so `onInvalidJSON` sees the text as transmitted.
  - `decode` is retyped from `DecodeJSON<unknown>` to `DecodeJSON<T>`.

### Patch Changes

- Updated dependencies
  - @sozai/async@0.2.0
