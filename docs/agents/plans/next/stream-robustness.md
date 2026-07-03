# stream — abort/cancel propagation + json-lines depth reset

**Status:** open · freeze-blocker · priority 7
**Source:** [audit 2026-07-02 — stream](../completed/2026-07-02-repo-audit.complete.md#stream)

The transport primitives have no abort/cancel/backpressure propagation and the json-lines
framer can permanently wedge. Only happy-path tests exist. This layer carries RPC framing,
so a wedged framer silently drops messages.

## Abort / cancel / backpressure

- **`src/connection.ts:13-29` — no abort/cancel propagation, no backpressure.** Aborting one
  side never errors the peer's controller (its reader hangs forever holding the lock);
  cancelling a readable isn't signaled back (next enqueue throws an opaque `TypeError`);
  `write` ignores `desiredSize`, so a slow consumer buffers unboundedly in the transport
  primitive.
- **`src/pipe.ts:19-25` — same gaps, plus close-after-drain throws:** after `drain()` closes
  the controller, a later `writer.close()` re-closes it → the writable's close rejects. Guard
  the controller close; add abort propagation.

## json-lines framer

- **`src/json-lines.ts:74` — one stray `]` or `}` line drives `nestingDepth` negative
  permanently;** all subsequent valid messages are silently swallowed/merged. Fix: on
  negative depth, route the line to `onInvalidJSON` and reset framer state.
- `src/json-lines.ts:121-124` — newline-in-string repair bypasses `processChar`, leaving
  `isEscapingChar` stale when the buffered string ends in a backslash. Fabricating `\n`
  content for invalid JSON is questionable — dropping the line as invalid is more predictable.
- `src/json-lines.ts:23-25` — custom `decode` is typed `DecodeJSON<unknown>` but its result
  is asserted as `T`; either type it `DecodeJSON<T>` or document that `T` is unchecked.

## Test-coverage gaps

Any abort/cancel/backpressure behavior; stray closing bracket in json-lines.
