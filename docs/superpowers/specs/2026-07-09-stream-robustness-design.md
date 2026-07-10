# stream — abort/cancel/backpressure propagation + json-lines recovery

**Date:** 2026-07-09
**Package:** `@sozai/stream`
**Source:** [next/stream-robustness.md](../../agents/plans/next/stream-robustness.md) ·
[audit 2026-07-02 — stream](../../agents/plans/completed/2026-07-02-repo-audit.complete.md#stream)

## Problem

`@sozai/stream` carries RPC framing for `enkaku`. Three classes of defect sit under that:

1. **`createConnection` / `createPipe` never propagate abort or cancel.** Aborting one side
   leaves the peer's `read()` pending forever, holding the reader lock. Cancelling a readable
   is invisible to the writer, whose next `enqueue` throws an opaque `TypeError` from a
   detached controller.
2. **Neither honours backpressure.** `write` ignores `desiredSize`, so a slow consumer
   buffers unboundedly inside the transport primitive.
3. **The json-lines framer can wedge permanently.** A single stray `]` or `}` line drives
   `nestingDepth` negative and it never returns to zero, so every subsequent message is
   silently swallowed or merged into a growing buffer.

Plus two smaller defects: the newline-in-string repair path bypasses `processChar`, leaving
`isEscapingChar` stale when a buffered string ends in a backslash; and `decode` is typed
`DecodeJSON<unknown>` while its result is asserted as `T`.

Coverage is happy-path only. None of the above is tested.

The package is a freeze candidate — consumers depend on published `^` ranges. Anything that
must exist in the frozen API surface has to land now.

## Non-goals

- No changes to `createReadable`, `writeTo`, `createArraySink`, or `transform.ts`.
- No new public API beyond an optional options argument on the two existing factories.
- No coordinated release with `enkaku`.

## Design

### 1. Internal `createChannel` primitive

`src/channel.ts`, not re-exported from `src/index.ts`.

```ts
export type ChannelOptions = { highWaterMark?: number }

export type Channel<T> = {
  readable: ReadableStream<T>
  writable: WritableStream<T>
  close: () => void
}
```

A half-duplex `T`-channel: a `ReadableStream<T>` plus the `WritableStream<T>` that feeds it.
`createConnection` is two channels crossed; `createPipe` is one channel plus `drain`. The
delicate semantics are written and tested once instead of twice.

#### Abort

`writable.abort(reason)` reaches the sink's `abort` callback, which calls
`controller.error(reason)` on the readable. A peer parked in `read()` rejects with `reason`
instead of hanging.

#### Cancel

`readable.cancel(reason)` reaches the readable's `cancel` callback, which records `reason` in
a channel-local failure slot. The writable's `write` and `close` callbacks consult that slot
first and throw. A `WritableStream` cannot be errored from outside without holding its writer
lock, so the flag is how the signal crosses; the observable effect is the intended one — the
next `write()` rejects with the cancel reason rather than an opaque `TypeError`.

#### Backpressure

Absent `highWaterMark`, `write` enqueues immediately and the readable's queue grows without
bound. This is byte-for-byte today's behavior, and it is the default: `createPipe`'s
documented contract is to queue written messages until they are read, and `enkaku`'s server
handlers write before anyone reads. A `ReadableStream` defaults to `highWaterMark: 1`, so
honouring `desiredSize` unconditionally would deadlock those call sites.

Given a `highWaterMark`, the readable is constructed with
`new CountQueuingStrategy({ highWaterMark })` and `write` awaits a deferred that the
readable's `pull` callback resolves whenever `desiredSize` becomes positive. A write parked
on that deferred rejects if the channel aborts or cancels while it waits — otherwise abort
would leave a promise dangling forever.

#### Close guard

`close()` is idempotent and swallows the already-closed case. Both the writable sink's `close`
callback and `pipe.drain()` route through it, so the order they run in stops mattering:
`drain()` closing the controller, then a later `writer.close()` reaching the sink, is the exact
sequence that rejects today.

### 2. Public signatures

```ts
function createConnection<AtoB, BtoA = AtoB>(
  options?: ChannelOptions,
): [ReadableWritablePair<BtoA, AtoB>, ReadableWritablePair<AtoB, BtoA>]

function createPipe<T>(options?: ChannelOptions): Pipe<T>
```

Both arguments optional; omitting them reproduces current behavior exactly. In
`createConnection`, one `highWaterMark` applies to both directions.

### 3. json-lines framer

#### Negative depth

When `}` or `]` arrives outside a string at depth 0, the accumulated message is unrecoverable.
Stop consuming, pass the accumulated text to `onInvalidJSON`, reset all four state variables
(`output`, `nestingDepth`, `isInString`, `isEscapingChar`), and resume framing at the next
newline. One stray bracket costs one message, not the rest of the stream.

#### Newline in string

Delete the `output.push('\\n')` branch. A raw newline inside a string literal is invalid JSON
and takes the same path as a stray bracket: report, reset, resume. The stale-`isEscapingChar`
bug disappears with the branch that caused it. `toJSONLines` never produces such input —
`JSON.stringify` escapes newlines — so only malformed peers are affected, and they should be
told rather than have content fabricated on their behalf.

#### Truncated messages at flush

For consistency with the above, a message left open at end of input — still inside a string,
or at a nesting depth above zero — reports to `onInvalidJSON` rather than being dropped in
silence as it is today. A truncated message is corruption, and the framer says so.

#### Keep whitespace in `output`

`output` today holds the message with whitespace stripped, so `onInvalidJSON` receives a
reconstruction rather than what arrived on the wire. `JSON.parse` accepts whitespace, so the
stripping buys nothing — and on the two new invalid paths it would force splicing a normalized
prefix onto a raw suffix to report anything at all.

`processChar` keeps its structural state machine (depth, in-string, escaping) but pushes every
character, whitespace included. `decode(output.join(''))` is unchanged in behavior;
`onInvalidJSON` now receives the exact offending text. A separate `hasContent` flag replaces
`output.length > 0` as the emit condition, so whitespace-only lines stay silently ignored.

Newline characters remain excluded — they are the frame separator and are sliced off before
`processChar` sees them. Dropping them is safe: within valid JSON no token spans a line break
except a string literal, and those are now rejected.

Two consequences, accepted:

- `maxMessageSize` measures the message as transmitted rather than as stripped. A
  pretty-printed message that squeaked under the cap may now exceed it.
- `onInvalidJSON`'s `value` argument regains the original whitespace.

#### `decode` typing

`decode?: DecodeJSON<T>`. A caller supplying a custom `decode` declares it returns `T`, so the
assertion is theirs to justify. The default `JSON.parse` returns `any` and still assigns.

## Error handling

No new exported error types. Abort and cancel reasons pass through verbatim, so a caller's
`AbortSignal.reason` or custom error arrives at the peer unwrapped.

`JSONLinesError` keeps its current role: size-limit violations and encode failures. Framing
corruption is deliberately **not** an error — it routes to `onInvalidJSON` and the stream stays
live. A transport that dies on one malformed peer message is worse than one that drops it.

## Testing

Channel behavior is tested through the two public entry points, not the internal module.

**`test/connection.test.ts`**

- Abort one side; the peer's pending `read()` rejects with the same reason.
- Cancel a readable; the peer's next `write()` rejects with the cancel reason.
- With `highWaterMark: 2`, the third write does not settle until a read drains one.
- Without the option, three writes settle with no reader attached.
- Abort while a write is parked on backpressure; that write rejects rather than dangling.

**`test/pipe.test.ts`**

- `drain()` followed by `writer.close()` resolves.
- Abort and cancel propagation, as above.

**`test/json-lines.test.ts`**

- A stray `]` line drops exactly that message, calls `onInvalidJSON` with the offending text,
  and the next valid line still decodes. This is the regression that motivates the item.
- A string containing a raw newline takes the same path.
- A string ending in a backslash immediately before the newline takes the same path — the
  stale-escape bug, stated as a test.

**Existing tests to change**

- `allows newlines in strings` inverts; it asserts the behavior being removed.
- The `onInvalidJSON` assertion at `test/json-lines.test.ts:85` expects the normalized value
  and regains its whitespace.
- `maxMessageSize` fixtures measure stripped length today; those near their boundary need
  their numbers rechecked once whitespace counts.

## Downstream impact

`enkaku` calls `createPipe`, `createConnection`, and `fromJSONLines` across six packages
(`client`, `server`, `transport`, `http-fetch`, `http-serve`, `node-streams`). Every public
signature stays call-compatible: the options argument is optional, the default is unbounded,
and nothing that resolves today begins rejecting.

The one visible shift is `DecodeJSON<T>`, affecting only a caller that passes a custom
`decode`. `enkaku/node-streams` forwards `FromJSONLinesOptions` without supplying one.

## Success criteria

- Aborting either side of a connection or pipe rejects the peer's pending read with the
  abort reason.
- Cancelling a readable rejects the peer's next write with the cancel reason.
- With `highWaterMark: n`, writes park once `n` messages are queued unread, and resume on read.
- Without `highWaterMark`, behavior is unchanged from `0.1.0`.
- `drain()` followed by `writer.close()` resolves.
- A stray closing bracket costs one message; the framer decodes the next valid line.
- `pnpm test` passes in `packages/stream` (types + unit).
