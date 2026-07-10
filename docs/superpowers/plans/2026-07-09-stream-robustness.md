# stream robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks
**Spec:** [2026-07-09-stream-robustness-design.md](../specs/2026-07-09-stream-robustness-design.md)

**Goal:** Give `@sozai/stream`'s transport primitives abort/cancel/backpressure propagation, and make the json-lines framer recover from corruption instead of wedging.

**Architecture:** Extract an internal half-duplex `createChannel` primitive (`src/channel.ts`) holding the abort, cancel, backpressure and close-guard semantics once. `createPipe` becomes one channel plus `drain`; `createConnection` becomes two channels crossed. Separately, rework the json-lines framer's character state machine to detect unbalanced brackets and raw newlines inside strings, reporting them via `onInvalidJSON` and resetting rather than corrupting `nestingDepth` forever.

**Tech Stack:** TypeScript, WHATWG Streams (`ReadableStream`/`WritableStream`/`TransformStream`), vitest, `@sozai/async` (`defer`, `onAbort`), biome.

## Global Constraints

- Package directory for all commands: `packages/stream`.
- `type` not `interface`. `Array<T>` not `T[]`. Never `any`. Capital `ID`/`HTTP`/`JWT`.
- ES `#fields`, never `private`/`readonly`. (No classes in this plan; noted for completeness.)
- Never edit generated files under `lib/`.
- Run vitest directly — `pnpm exec vitest run`, never `pnpm run test:unit`. An `rtk` shim on this machine intercepts `pnpm run <script>` and redirects it to the wrong tool.
- Lint with `pnpm exec biome check --write src test` from `packages/stream`.
- Public signatures must stay call-compatible: every new argument is optional and every current default reproduces `0.1.0` behavior.
- `src/channel.ts` is internal. It must NOT be re-exported from `src/index.ts`.

---

## Two facts the implementation depends on

Read these before Task 2 or Task 3. Both are non-obvious and getting them wrong produces a hang, not a test failure.

**1. Park before enqueue.** `write` must wait for capacity *before* calling `controller.enqueue`, not after. A `ReadableStream` built with `new CountQueuingStrategy({ highWaterMark: 2 })` starts with `desiredSize === 2`. Parking after enqueue would block the second write; parking before it blocks the third, which is the documented contract.

**2. A parked write cannot be rescued by the sink's `abort` callback.** In the WHATWG streams spec, `WritableStreamStartErroring` only reaches `WritableStreamFinishErroring` — and therefore the sink's `abort` callback — once `[[inFlightWriteRequest]]` is undefined. A write parked forever inside the sink means `writer.abort(reason)` never fires the callback, and both promises hang.

The escape hatch is the second argument to the sink's `write` callback: a `WritableStreamDefaultController` carrying a `signal: AbortSignal` that `WritableStreamStartErroring` aborts *synchronously*, before any of that waiting. So a parked write races its capacity deferred against `signal`. `@sozai/async` exports `onAbort(signal, fn): () => void` for exactly this, and it returns an unsubscribe that must be called on the normal path so the listener does not leak.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/channel.ts` (create) | Internal half-duplex channel: readable + feeding writable, abort/cancel/backpressure/close-guard |
| `src/pipe.ts` (rewrite) | `createPipe` = one channel + `drain` |
| `src/connection.ts` (rewrite) | `createConnection` = two channels crossed |
| `src/json-lines.ts` (modify) | Framer corruption recovery, whitespace retention, `decode` typing |
| `src/index.ts` | Unchanged — `channel.ts` stays internal |
| `test/pipe.test.ts` | Channel semantics exercised through `createPipe` |
| `test/connection.test.ts` | Channel semantics exercised through `createConnection` |
| `test/json-lines.test.ts` | Framer recovery cases; three existing tests change |

---

### Task 1: Internal channel primitive, wired into createPipe

Establishes `createChannel` with enqueue, close-guard, and `drain` compatibility. No abort, cancel, or backpressure yet — those are Tasks 2 and 3. The deliverable is `createPipe` behaving exactly as today, plus the close-after-drain bug fixed.

**Files:**
- Create: `packages/stream/src/channel.ts`
- Modify: `packages/stream/src/pipe.ts` (full rewrite, 41 lines)
- Test: `packages/stream/test/pipe.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createChannel<T>(options?: ChannelOptions): Channel<T>` where
  `type ChannelOptions = { highWaterMark?: number }` and
  `type Channel<T> = { readable: ReadableStream<T>; writable: WritableStream<T>; close: () => void }`.
  Tasks 2, 3 and 4 all build on these exact names.

- [ ] **Step 1: Write the failing test**

Append to `packages/stream/test/pipe.test.ts`, inside the existing `describe('createPipe()')` block:

```ts
  test('drain then writer.close() resolves', async () => {
    const pipe = createPipe<string>()

    const received: Array<string> = []
    const pipePromise = pipe.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          received.push(chunk)
        },
      }),
    )

    const writer = pipe.writable.getWriter()
    await writer.write('one')
    await pipe.drain(pipePromise)

    // drain() already closed the controller; the writer must not reject on close
    await expect(writer.close()).resolves.toBeUndefined()
    expect(received).toEqual(['one'])
  })
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/stream && pnpm exec vitest run test/pipe.test.ts -t 'drain then writer.close'
```

Expected: FAIL. The controller was already closed by `drain()`, so the sink's `close` callback calls `controller.close()` a second time and the writer's close promise rejects with `TypeError: Invalid state: Controller is already closed`.

- [ ] **Step 3: Write the channel primitive**

Create `packages/stream/src/channel.ts`:

```ts
/**
 * Internal half-duplex channel: a `ReadableStream` and the `WritableStream` that feeds it.
 *
 * Not exported from the package. `createPipe` is one channel; `createConnection` is two
 * channels crossed. The abort, cancel, backpressure and close-guard semantics live here so
 * they are written and tested once.
 */

export type ChannelOptions = {
  /**
   * Bound the number of messages buffered in the readable before `write` awaits a read.
   *
   * Omitted (the default), the readable's queue grows without bound and `write` always
   * resolves immediately, matching a queue-until-read contract.
   */
  highWaterMark?: number
}

export type Channel<T> = {
  readable: ReadableStream<T>
  writable: WritableStream<T>
  /** Idempotent close of the readable side. Safe to call after close or error. */
  close: () => void
}

export function createChannel<T>(options: ChannelOptions = {}): Channel<T> {
  const { highWaterMark } = options

  let controller: ReadableStreamDefaultController<T>
  let closed = false

  const strategy = highWaterMark == null ? undefined : new CountQueuingStrategy({ highWaterMark })
  const readable = new ReadableStream<T>(
    {
      start(ctrl) {
        controller = ctrl
      },
    },
    strategy,
  )

  function close(): void {
    if (closed) {
      return
    }
    closed = true
    try {
      controller.close()
    } catch {
      // Controller may already be closed or errored
    }
  }

  const writable = new WritableStream<T>({
    write(msg) {
      controller.enqueue(msg)
    },
    close() {
      close()
    },
  })

  return { readable, writable, close }
}
```

- [ ] **Step 4: Rewrite createPipe on top of it**

Replace the entire contents of `packages/stream/src/pipe.ts`:

```ts
import { type ChannelOptions, createChannel } from './channel.js'

export type Pipe<T> = ReadableWritablePair<T, T> & {
  drain: (pipePromise: Promise<void>) => Promise<void>
}

/**
 * Create a `ReadableWritablePair` stream queuing written messages until they are read from the other end.
 *
 * The returned `drain` function closes the readable directly (bypassing the
 * writable's writer lock) and waits for the given `pipePromise` to flush all
 * buffered values.
 */
export function createPipe<T>(options: ChannelOptions = {}): Pipe<T> {
  const { readable, writable, close } = createChannel<T>(options)

  async function drain(pipePromise: Promise<void>): Promise<void> {
    close()
    try {
      await pipePromise
    } catch {
      // Pipe may have errored
    }
  }

  return { readable, writable, drain }
}
```

- [ ] **Step 5: Run the full pipe suite**

```bash
cd packages/stream && pnpm exec vitest run test/pipe.test.ts
```

Expected: PASS, 4 tests. The three pre-existing tests still pass — `close()` is idempotent, so `drain()` followed by the sink's `close` callback is now safe in either order.

- [ ] **Step 6: Verify nothing else regressed**

```bash
cd packages/stream && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.test.json
```

Expected: all suites PASS, no type errors.

- [ ] **Step 7: Lint and commit**

```bash
cd packages/stream && pnpm exec biome check --write src test
cd ../.. && git add packages/stream/src/channel.ts packages/stream/src/pipe.ts packages/stream/test/pipe.test.ts
git commit -m "feat(stream): internal channel primitive, idempotent close

createPipe now delegates to createChannel. Guards the controller close so
drain() followed by writer.close() resolves instead of rejecting."
```

---

### Task 2: Abort and cancel propagation

**Files:**
- Modify: `packages/stream/src/channel.ts`
- Test: `packages/stream/test/pipe.test.ts`

**Interfaces:**
- Consumes: `createChannel`, `Channel<T>`, `ChannelOptions` from Task 1.
- Produces: no signature change. Adds behavior: `writable.abort(reason)` errors `readable` with `reason`; `readable.cancel(reason)` makes the next `writable` write or close reject with `reason`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/stream/test/pipe.test.ts`, inside `describe('createPipe()')`:

```ts
  test('abort errors the readable with the same reason', async () => {
    const { readable, writable } = createPipe<string>()
    const reason = new Error('gone')

    const reader = readable.getReader()
    const read = reader.read()

    await writable.abort(reason)

    await expect(read).rejects.toBe(reason)
  })

  test('cancel rejects the next write with the cancel reason', async () => {
    const { readable, writable } = createPipe<string>()
    const reason = new Error('receiver left')

    await readable.cancel(reason)

    const writer = writable.getWriter()
    await expect(writer.write('one')).rejects.toBe(reason)
  })

  test('cancel rejects a subsequent close with the cancel reason', async () => {
    const { readable, writable } = createPipe<string>()
    const reason = new Error('receiver left')

    await readable.cancel(reason)

    const writer = writable.getWriter()
    await expect(writer.close()).rejects.toBe(reason)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/stream && pnpm exec vitest run test/pipe.test.ts -t 'abort errors the readable'
cd packages/stream && pnpm exec vitest run test/pipe.test.ts -t 'cancel rejects'
```

Expected: the abort test hangs then times out — the pending `read()` never settles, which is the bug. The cancel tests FAIL with an opaque `TypeError: Invalid state: WritableStream is closed` or an enqueue-on-detached-controller `TypeError`, not with `reason`.

- [ ] **Step 3: Add the failure slot and the two callbacks**

In `packages/stream/src/channel.ts`, replace the body of `createChannel` (keep the exported types untouched):

```ts
export function createChannel<T>(options: ChannelOptions = {}): Channel<T> {
  const { highWaterMark } = options

  let controller: ReadableStreamDefaultController<T>
  let closed = false
  // Set when the readable is cancelled. A WritableStream cannot be errored from outside
  // without its writer lock, so the reason crosses to the writable through this slot and
  // is thrown by the sink callbacks.
  let failure: { reason: unknown } | undefined

  const strategy = highWaterMark == null ? undefined : new CountQueuingStrategy({ highWaterMark })
  const readable = new ReadableStream<T>(
    {
      start(ctrl) {
        controller = ctrl
      },
      cancel(reason) {
        closed = true
        failure ??= { reason }
      },
    },
    strategy,
  )

  function close(): void {
    if (closed) {
      return
    }
    closed = true
    try {
      controller.close()
    } catch {
      // Controller may already be closed or errored
    }
  }

  const writable = new WritableStream<T>({
    write(msg) {
      if (failure != null) {
        throw failure.reason
      }
      controller.enqueue(msg)
    },
    close() {
      if (failure != null) {
        throw failure.reason
      }
      close()
    },
    abort(reason) {
      if (closed) {
        return
      }
      closed = true
      controller.error(reason)
    },
  })

  return { readable, writable, close }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/stream && pnpm exec vitest run test/pipe.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Verify nothing else regressed**

```bash
cd packages/stream && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.test.json
```

Expected: all suites PASS, no type errors.

- [ ] **Step 6: Lint and commit**

```bash
cd packages/stream && pnpm exec biome check --write src test
cd ../.. && git add packages/stream/src/channel.ts packages/stream/test/pipe.test.ts
git commit -m "feat(stream): propagate abort and cancel across a channel

Aborting a writable errors the peer readable with the same reason instead of
leaving its reader parked forever. Cancelling a readable makes the next write
or close reject with the cancel reason instead of an opaque TypeError from a
detached controller."
```

---

### Task 3: Opt-in backpressure

Read "Two facts the implementation depends on" above before starting.

**Files:**
- Modify: `packages/stream/src/channel.ts`
- Test: `packages/stream/test/pipe.test.ts`

**Interfaces:**
- Consumes: `createChannel`, `ChannelOptions` (with its already-declared `highWaterMark`) from Tasks 1-2.
- Produces: no signature change. Adds behavior: given `highWaterMark: n`, the `(n+1)`th unread write parks until a read frees capacity; a parked write rejects if the channel is aborted or cancelled while it waits.

- [ ] **Step 1: Write the failing tests**

Append to `packages/stream/test/pipe.test.ts`, inside `describe('createPipe()')`:

```ts
  test('without highWaterMark, writes settle with no reader attached', async () => {
    const { writable } = createPipe<string>()
    const writer = writable.getWriter()

    await expect(
      Promise.all([writer.write('one'), writer.write('two'), writer.write('three')]),
    ).resolves.toHaveLength(3)
  })

  test('with highWaterMark, the write past capacity parks until a read drains one', async () => {
    const { readable, writable } = createPipe<string>({ highWaterMark: 2 })
    const writer = writable.getWriter()

    await writer.write('one')
    await writer.write('two')

    let settled = false
    const third = writer.write('three').then(() => {
      settled = true
    })

    // Give the parked write every chance to settle on its own
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)

    const reader = readable.getReader()
    await expect(reader.read()).resolves.toEqual({ done: false, value: 'one' })

    await third
    expect(settled).toBe(true)
  })

  test('aborting while a write is parked rejects that write', async () => {
    const { writable } = createPipe<string>({ highWaterMark: 1 })
    const reason = new Error('gone')
    const writer = writable.getWriter()

    await writer.write('one')
    const parked = writer.write('two')

    await writer.abort(reason)

    await expect(parked).rejects.toBe(reason)
  })

  test('cancelling while a write is parked rejects that write', async () => {
    const { readable, writable } = createPipe<string>({ highWaterMark: 1 })
    const reason = new Error('receiver left')
    const writer = writable.getWriter()

    await writer.write('one')
    const parked = writer.write('two')

    await readable.cancel(reason)

    await expect(parked).rejects.toBe(reason)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/stream && pnpm exec vitest run test/pipe.test.ts -t 'highWaterMark'
cd packages/stream && pnpm exec vitest run test/pipe.test.ts -t 'while a write is parked'
```

Expected: `without highWaterMark` PASSES already (that is the current behavior, pinned as a regression guard). The other three FAIL: `createPipe` takes no options yet, so `desiredSize` is ignored, `settled` is `true` immediately, and the "parked" writes resolve rather than reject.

- [ ] **Step 3: Implement capacity waiting**

Replace the entire contents of `packages/stream/src/channel.ts`:

```ts
import { type Deferred, defer, onAbort } from '@sozai/async'

/**
 * Internal half-duplex channel: a `ReadableStream` and the `WritableStream` that feeds it.
 *
 * Not exported from the package. `createPipe` is one channel; `createConnection` is two
 * channels crossed. The abort, cancel, backpressure and close-guard semantics live here so
 * they are written and tested once.
 */

export type ChannelOptions = {
  /**
   * Bound the number of messages buffered in the readable before `write` awaits a read.
   *
   * Omitted (the default), the readable's queue grows without bound and `write` always
   * resolves immediately, matching a queue-until-read contract.
   */
  highWaterMark?: number
}

export type Channel<T> = {
  readable: ReadableStream<T>
  writable: WritableStream<T>
  /** Idempotent close of the readable side. Safe to call after close or error. */
  close: () => void
}

export function createChannel<T>(options: ChannelOptions = {}): Channel<T> {
  const { highWaterMark } = options

  let controller: ReadableStreamDefaultController<T>
  let closed = false
  // Set when the readable is cancelled. A WritableStream cannot be errored from outside
  // without its writer lock, so the reason crosses to the writable through this slot and
  // is thrown by the sink callbacks.
  let failure: { reason: unknown } | undefined
  // Resolved by `pull` when the readable's queue has room again.
  let capacity: Deferred<void> | undefined

  function releaseCapacity(): void {
    capacity?.resolve()
    capacity = undefined
  }

  function rejectCapacity(reason: unknown): void {
    capacity?.reject(reason)
    capacity = undefined
  }

  const strategy = highWaterMark == null ? undefined : new CountQueuingStrategy({ highWaterMark })
  const readable = new ReadableStream<T>(
    {
      start(ctrl) {
        controller = ctrl
      },
      pull() {
        releaseCapacity()
      },
      cancel(reason) {
        closed = true
        failure ??= { reason }
        rejectCapacity(reason)
      },
    },
    strategy,
  )

  function close(): void {
    if (closed) {
      return
    }
    closed = true
    try {
      controller.close()
    } catch {
      // Controller may already be closed or errored
    }
  }

  /**
   * Wait until the readable's queue has room.
   *
   * Races the `pull` signal against the writable's abort signal: the streams spec defers a
   * WritableStream's `abort` callback until any in-flight write settles, so a write parked
   * here can only be released by the signal, never by the sink's `abort`.
   */
  async function waitForCapacity(signal: AbortSignal): Promise<void> {
    while ((controller.desiredSize ?? 0) <= 0) {
      signal.throwIfAborted()
      capacity = defer<void>()
      const unsubscribe = onAbort(signal, () => {
        rejectCapacity(signal.reason)
      })
      try {
        await capacity.promise
      } finally {
        unsubscribe()
      }
      if (failure != null) {
        throw failure.reason
      }
    }
  }

  const writable = new WritableStream<T>({
    async write(msg, ctrl) {
      if (failure != null) {
        throw failure.reason
      }
      if (highWaterMark != null) {
        await waitForCapacity(ctrl.signal)
      }
      controller.enqueue(msg)
    },
    close() {
      if (failure != null) {
        throw failure.reason
      }
      close()
    },
    abort(reason) {
      if (closed) {
        return
      }
      closed = true
      controller.error(reason)
    },
  })

  return { readable, writable, close }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/stream && pnpm exec vitest run test/pipe.test.ts
```

Expected: PASS, 11 tests.

If `aborting while a write is parked` times out rather than failing, the parked write is not observing `ctrl.signal` — recheck that `write` takes its second parameter and passes `ctrl.signal` into `waitForCapacity`.

- [ ] **Step 5: Verify nothing else regressed**

```bash
cd packages/stream && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.test.json
```

Expected: all suites PASS, no type errors.

- [ ] **Step 6: Lint and commit**

```bash
cd packages/stream && pnpm exec biome check --write src test
cd ../.. && git add packages/stream/src/channel.ts packages/stream/test/pipe.test.ts
git commit -m "feat(stream): opt-in backpressure via highWaterMark

Without the option the queue grows unbounded, exactly as before. With it, a
write past capacity parks until a read frees a slot, and rejects if the
channel aborts or is cancelled while parked."
```

---

### Task 4: createConnection on channels

**Files:**
- Modify: `packages/stream/src/connection.ts` (full rewrite, 35 lines)
- Test: `packages/stream/test/connection.test.ts`

**Interfaces:**
- Consumes: `createChannel`, `ChannelOptions` from Tasks 1-3.
- Produces: `createConnection<AtoB, BtoA = AtoB>(options?: ChannelOptions): [ReadableWritablePair<BtoA, AtoB>, ReadableWritablePair<AtoB, BtoA>]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/stream/test/connection.test.ts`, inside `describe('createConnection()')`:

```ts
  test('aborting one side errors the peer pending read', async () => {
    const [client, server] = createConnection<string>()
    const reason = new Error('client gone')

    const serverReader = server.readable.getReader()
    const read = serverReader.read()

    await client.writable.abort(reason)

    await expect(read).rejects.toBe(reason)
  })

  test('cancelling a readable rejects the peer next write', async () => {
    const [client, server] = createConnection<string>()
    const reason = new Error('server stopped reading')

    await server.readable.cancel(reason)

    const clientWriter = client.writable.getWriter()
    await expect(clientWriter.write('hello')).rejects.toBe(reason)
  })

  test('one direction aborting leaves the other usable', async () => {
    const [client, server] = createConnection<string>()

    await client.writable.abort(new Error('client gone'))

    const serverWriter = server.writable.getWriter()
    await serverWriter.write('still here')
    const clientRead = await client.readable.getReader().read()
    expect(clientRead.value).toBe('still here')
  })

  test('highWaterMark applies to both directions', async () => {
    const [client, server] = createConnection<string>({ highWaterMark: 1 })

    const clientWriter = client.writable.getWriter()
    await clientWriter.write('one')

    let settled = false
    const parked = clientWriter.write('two').then(() => {
      settled = true
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)

    const serverReader = server.readable.getReader()
    await expect(serverReader.read()).resolves.toEqual({ done: false, value: 'one' })
    await parked
    expect(settled).toBe(true)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/stream && pnpm exec vitest run test/connection.test.ts
```

Expected: the abort test times out (peer read never settles). The cancel test FAILS with an opaque `TypeError`. The `highWaterMark` test FAILS to compile — `createConnection` takes no arguments — surfacing as a vitest transform error or an immediate `settled === true`.

- [ ] **Step 3: Rewrite createConnection**

Replace the entire contents of `packages/stream/src/connection.ts`:

```ts
import { type ChannelOptions, createChannel } from './channel.js'

/**
 * Create a tuple of `ReadableWritablePair` streams connected to each other.
 *
 * Each direction is an independent channel: aborting or cancelling one leaves the other
 * usable. The `highWaterMark` option, if given, applies to both directions.
 */
export function createConnection<AtoB, BtoA = AtoB>(
  options: ChannelOptions = {},
): [ReadableWritablePair<BtoA, AtoB>, ReadableWritablePair<AtoB, BtoA>] {
  // `toA` carries messages B writes and A reads; `toB` the reverse.
  const toA = createChannel<BtoA>(options)
  const toB = createChannel<AtoB>(options)

  return [
    { readable: toA.readable, writable: toB.writable },
    { readable: toB.readable, writable: toA.writable },
  ]
}
```

Note `createReadable` is no longer imported here. It stays exported from `src/readable.ts` — `enkaku`'s `http-fetch` and `http-serve` packages both use it.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/stream && pnpm exec vitest run test/connection.test.ts
```

Expected: PASS, 5 tests. The pre-existing `reads and writes` test still passes.

- [ ] **Step 5: Verify nothing else regressed**

```bash
cd packages/stream && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.test.json
```

Expected: all suites PASS, no type errors.

- [ ] **Step 6: Lint and commit**

```bash
cd packages/stream && pnpm exec biome check --write src test
cd ../.. && git add packages/stream/src/connection.ts packages/stream/test/connection.test.ts
git commit -m "feat(stream): createConnection gains abort, cancel and backpressure

Built from two crossed channels, so each direction fails independently."
```

---

### Task 5: json-lines keeps whitespace in the message buffer

Behavior-preserving refactor. It lands first because Tasks 6 and 7 report the offending text to `onInvalidJSON`, and reporting a whitespace-stripped reconstruction of text that never appeared on the wire is worse than useless for diagnosing a malformed peer.

**Files:**
- Modify: `packages/stream/src/json-lines.ts:44-153`
- Test: `packages/stream/test/json-lines.test.ts:85` (assertion update)

**Interfaces:**
- Consumes: nothing from earlier tasks. Tasks 5-8 touch only `json-lines.ts` and are independent of Tasks 1-4.
- Produces: internal `resetFramer(): void`, `emit(controller: TransformStreamDefaultController<T>): void`, and a `hasContent` flag replacing `output.length > 0` as the emit condition. Tasks 6 and 7 build on all three.

- [ ] **Step 1: Update the existing assertion to the new expectation**

`onInvalidJSON` currently receives `'{"invalid":json}'` — the space after the colon stripped out. It should receive what arrived. In `packages/stream/test/json-lines.test.ts:85`, change:

```ts
    expect(onInvalidJSON).toHaveBeenCalledWith(
      '{"invalid":json}',
      expect.any(TransformStreamDefaultController),
    )
```

to:

```ts
    expect(onInvalidJSON).toHaveBeenCalledWith(
      '{"invalid": json}',
      expect.any(TransformStreamDefaultController),
    )
```

- [ ] **Step 2: Add a test pinning that whitespace-only lines stay ignored**

This is the one behavior the `hasContent` flag exists to preserve. Append inside `describe('fromJSONLines()')`:

```ts
  test('ignores blank and whitespace-only lines', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('\n')
    controller.enqueue('   \n')
    controller.enqueue('{"foo":"bar"}\n')
    controller.close()

    await expect(result).resolves.toEqual([{ foo: 'bar' }])
    expect(onInvalidJSON).not.toHaveBeenCalled()
  })

  test('a discarded whitespace-only line does not leak into the next message', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('   \n')
    controller.enqueue('bad json\n')
    controller.close()

    await expect(result).resolves.toEqual([])
    // The reported text is the offending line, not the prior line's whitespace spliced on
    expect(onInvalidJSON).toHaveBeenCalledWith(
      'bad json',
      expect.any(TransformStreamDefaultController),
    )
  })

  test('a discarded whitespace-only line does not consume maxMessageSize', async () => {
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ maxMessageSize: 4 })).pipeTo(sink)

    controller.enqueue('   \n')
    controller.enqueue('{}\n')
    controller.close()

    // `{}` is 2 characters; the 3 spaces on the prior line must not count against the cap
    await expect(result).resolves.toEqual([{}])
  })
```

The `ignores blank and whitespace-only lines` test above passes even with `output` never cleared, because `JSON.parse` tolerates leading whitespace. The two tests that follow it are the ones that actually pin the reset: without it, the first reports `'   bad json'` and the second throws `Message size 5 exceeds maximum message size of 4`.

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd packages/stream && pnpm exec vitest run test/json-lines.test.ts -t 'calls onInvalidJSON when JSON is invalid'
```

Expected: FAIL — received `'{"invalid":json}'`, expected `'{"invalid": json}'`.

```bash
cd packages/stream && pnpm exec vitest run test/json-lines.test.ts -t 'ignores blank and whitespace-only lines'
```

Expected: PASS. It guards a behavior that must survive Step 4, not one being added.

- [ ] **Step 4: Retain whitespace, track content separately**

In `packages/stream/src/json-lines.ts`, replace the state declarations and `processChar` (currently lines 44-84) with:

```ts
  const decoder = new TextDecoder()
  let input = ''
  let output: Array<string> = []
  let nestingDepth = 0
  let isInString = false
  let isEscapingChar = false
  // Whether `output` holds any non-whitespace character. Replaces `output.length > 0` as the
  // emit condition now that whitespace is retained, so blank lines stay silently ignored.
  let hasContent = false

  function resetFramer(): void {
    output = []
    nestingDepth = 0
    isInString = false
    isEscapingChar = false
    hasContent = false
  }

  function processChar(char: string): void {
    if (isInString) {
      if (char === '\\') {
        isEscapingChar = !isEscapingChar
      } else {
        if (char === '"' && !isEscapingChar) {
          isInString = false
        }
        isEscapingChar = false
      }
      output.push(char)
      return
    }
    switch (char) {
      case '"':
        isInString = true
        hasContent = true
        output.push(char)
        break
      case '{':
      case '[':
        nestingDepth++
        hasContent = true
        output.push(char)
        break
      case '}':
      case ']':
        nestingDepth--
        output.push(char)
        break
      default:
        output.push(char)
        // Whitespace is retained but does not make a message worth emitting.
        // charCode comparison instead of a regex.
        if (char.charCodeAt(0) > 32) {
          hasContent = true
        }
    }
  }

  function emit(controller: TransformStreamDefaultController<T>): void {
    const value = output.join('')
    resetFramer()
    try {
      controller.enqueue(decode(value))
    } catch {
      onInvalidJSON(value, controller)
    }
  }
```

Then rewrite the `transform` and `flush` callbacks (currently lines 102-152) to use `hasContent` and `emit`:

```ts
  return transform<Uint8Array | string, T>(
    (chunk, controller) => {
      try {
        input += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
        checkBufferSize()
        let newLineIndex = input.indexOf(SEPARATOR)
        while (newLineIndex !== -1) {
          const line = input.slice(0, newLineIndex)
          input = input.slice(newLineIndex + SEPARATOR.length)
          for (const char of line) {
            processChar(char)
          }
          checkBufferSize()
          if (nestingDepth === 0 && !isInString && hasContent) {
            checkOutputSize()
            emit(controller)
          } else if (isInString) {
            // Retained for now; Task 7 replaces this with rejection
            output.push('\\n')
          } else if (nestingDepth === 0) {
            // A whitespace-only line: nothing to emit, but its characters must not carry
            // into the next message. `emit` is the only other path that clears `output`.
            resetFramer()
          }
          newLineIndex = input.indexOf(SEPARATOR)
        }
      } catch (cause) {
        if (cause instanceof JSONLinesError) {
          throw cause
        }
        controller.error(new JSONLinesError('Error processing chunk', { cause }))
      }
    },
    (controller) => {
      // No checkBufferSize() here: every chunk already passed the cap in the
      // transform callback, and flush only appends the decoder's pending
      // multibyte remainder (bounded) before emitting the final buffered value.
      input += decoder.decode()
      for (const char of input) {
        processChar(char)
      }
      if (nestingDepth === 0 && !isInString && hasContent) {
        checkOutputSize()
        emit(controller)
      }
    },
  )
```

Two things changed structurally besides whitespace retention. `input` is sliced *before* the line is processed, so `checkBufferSize()` no longer double-counts the line in both `input` and `output`. And the `output = []` reset after enqueue moved inside `emit` via `resetFramer()`.

- [ ] **Step 5: Run the full framer suite**

```bash
cd packages/stream && pnpm exec vitest run test/json-lines.test.ts
```

Expected: PASS, 16 tests. Note in particular that `parses formatted JSON` still passes: the retained indentation is legal JSON whitespace, and the newline separators are sliced off before `processChar` sees them, so `{\n  "foo": "bar"\n}` joins to `  {        "foo": "bar"    }`, which `JSON.parse` accepts.

- [ ] **Step 6: Verify nothing else regressed**

```bash
cd packages/stream && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.test.json
```

Expected: all suites PASS, no type errors.

- [ ] **Step 7: Lint and commit**

```bash
cd packages/stream && pnpm exec biome check --write src test
cd ../.. && git add packages/stream/src/json-lines.ts packages/stream/test/json-lines.test.ts
git commit -m "refactor(stream): json-lines retains whitespace in the message buffer

JSON.parse accepts whitespace, so stripping it bought nothing and made
onInvalidJSON report a reconstruction rather than the received text. A
hasContent flag takes over as the emit condition so blank lines stay ignored."
```

---

### Task 6: json-lines recovers from unbalanced closing brackets

The freeze-blocker. One stray `]` or `}` currently drives `nestingDepth` negative forever, silently swallowing every subsequent message.

**Files:**
- Modify: `packages/stream/src/json-lines.ts`
- Test: `packages/stream/test/json-lines.test.ts`

**Interfaces:**
- Consumes: `resetFramer`, `emit`, `hasContent` from Task 5.
- Produces: internal `invalidate(controller: TransformStreamDefaultController<T>): void` and `feedLine(line: string, controller: TransformStreamDefaultController<T>): boolean` (returns `false` when the line corrupted the framer). Task 7 calls both.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('fromJSONLines()')`:

```ts
  test('recovers from a stray closing bracket', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('{"first":1}\n')
    controller.enqueue(']\n')
    controller.enqueue('{"second":2}\n')
    controller.close()

    // The stray bracket costs exactly one message; the framer keeps going
    await expect(result).resolves.toEqual([{ first: 1 }, { second: 2 }])
    expect(onInvalidJSON).toHaveBeenCalledTimes(1)
    expect(onInvalidJSON).toHaveBeenCalledWith(']', expect.any(TransformStreamDefaultController))
  })

  test('reports the whole offending line when a bracket unbalances mid-line', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('{"a":1}}{"b":2}\n')
    controller.enqueue('{"ok":true}\n')
    controller.close()

    await expect(result).resolves.toEqual([{ ok: true }])
    expect(onInvalidJSON).toHaveBeenCalledWith(
      '{"a":1}}{"b":2}',
      expect.any(TransformStreamDefaultController),
    )
  })

  test('recovers from a stray closing bracket inside a multi-line message', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('{\n')
    controller.enqueue('"a":1}}\n')
    controller.enqueue('{"next":true}\n')
    controller.close()

    await expect(result).resolves.toEqual([{ next: true }])
    expect(onInvalidJSON).toHaveBeenCalledWith(
      '{"a":1}}',
      expect.any(TransformStreamDefaultController),
    )
  })
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/stream && pnpm exec vitest run test/json-lines.test.ts -t 'stray closing bracket'
```

Expected: FAIL. `recovers from a stray closing bracket` resolves to `[{ first: 1 }]` — `nestingDepth` sits at `-1` after the `]` line, so `{"second":2}` brings it back to `0` only at its own closing brace and never satisfies the emit condition on a later line. `onInvalidJSON` is never called.

- [ ] **Step 3: Detect the unbalance and reset**

In `packages/stream/src/json-lines.ts`, change `processChar` to report corruption. Replace its `'}' / ']'` case and its return type:

```ts
  /** Returns false when the character unbalances the framer beyond recovery. */
  function processChar(char: string): boolean {
    if (isInString) {
      if (char === '\\') {
        isEscapingChar = !isEscapingChar
      } else {
        if (char === '"' && !isEscapingChar) {
          isInString = false
        }
        isEscapingChar = false
      }
      output.push(char)
      return true
    }
    switch (char) {
      case '"':
        isInString = true
        hasContent = true
        output.push(char)
        return true
      case '{':
      case '[':
        nestingDepth++
        hasContent = true
        output.push(char)
        return true
      case '}':
      case ']':
        output.push(char)
        if (nestingDepth === 0) {
          // A closing bracket with nothing open. Everything accumulated is garbage.
          return false
        }
        nestingDepth--
        return true
      default:
        output.push(char)
        // Whitespace is retained but does not make a message worth emitting.
        // charCode comparison instead of a regex.
        if (char.charCodeAt(0) > 32) {
          hasContent = true
        }
        return true
    }
  }
```

Add `invalidate` and `feedLine` beside `emit`:

```ts
  function invalidate(controller: TransformStreamDefaultController<T>): void {
    const value = output.join('')
    resetFramer()
    onInvalidJSON(value, controller)
  }

  /**
   * Feed one framed line through the state machine.
   *
   * Returns false when the line corrupted the framer, in which case the accumulated message
   * has already been reported to `onInvalidJSON` and the state reset. The remainder of a
   * corrupt line is captured verbatim so the report shows what actually arrived.
   */
  function feedLine(line: string, controller: TransformStreamDefaultController<T>): boolean {
    let corrupt = false
    for (const char of line) {
      if (corrupt) {
        output.push(char)
      } else if (!processChar(char)) {
        corrupt = true
      }
    }
    if (corrupt) {
      invalidate(controller)
      return false
    }
    return true
  }
```

Rewrite the `transform` and `flush` callbacks to route through `feedLine`:

```ts
  return transform<Uint8Array | string, T>(
    (chunk, controller) => {
      try {
        input += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
        checkBufferSize()
        let newLineIndex = input.indexOf(SEPARATOR)
        while (newLineIndex !== -1) {
          const line = input.slice(0, newLineIndex)
          input = input.slice(newLineIndex + SEPARATOR.length)
          if (feedLine(line, controller)) {
            checkBufferSize()
            if (nestingDepth === 0 && !isInString && hasContent) {
              checkOutputSize()
              emit(controller)
            } else if (isInString) {
              // Retained for now; Task 7 replaces this with rejection
              output.push('\\n')
            } else if (nestingDepth === 0) {
              // Whitespace-only line: clear it so it cannot carry into the next message
              resetFramer()
            }
          }
          newLineIndex = input.indexOf(SEPARATOR)
        }
      } catch (cause) {
        if (cause instanceof JSONLinesError) {
          throw cause
        }
        controller.error(new JSONLinesError('Error processing chunk', { cause }))
      }
    },
    (controller) => {
      // No checkBufferSize() here: every chunk already passed the cap in the
      // transform callback, and flush only appends the decoder's pending
      // multibyte remainder (bounded) before emitting the final buffered value.
      input += decoder.decode()
      if (feedLine(input, controller) && nestingDepth === 0 && !isInString && hasContent) {
        checkOutputSize()
        emit(controller)
      }
    },
  )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/stream && pnpm exec vitest run test/json-lines.test.ts
```

Expected: PASS, 19 tests.

- [ ] **Step 5: Verify nothing else regressed**

```bash
cd packages/stream && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.test.json
```

Expected: all suites PASS, no type errors.

- [ ] **Step 6: Lint and commit**

```bash
cd packages/stream && pnpm exec biome check --write src test
cd ../.. && git add packages/stream/src/json-lines.ts packages/stream/test/json-lines.test.ts
git commit -m "fix(stream): json-lines recovers from unbalanced closing brackets

A stray ] or } drove nestingDepth negative permanently, silently swallowing
every subsequent message. The offending text now goes to onInvalidJSON and the
framer resets, costing one message rather than the rest of the stream."
```

---

### Task 7: json-lines rejects raw newlines inside strings

**Files:**
- Modify: `packages/stream/src/json-lines.ts`
- Test: `packages/stream/test/json-lines.test.ts:21-30` (inverted)

**Interfaces:**
- Consumes: `invalidate`, `feedLine` from Task 6.
- Produces: no new interfaces. Removes the `output.push('\\n')` branch.

- [ ] **Step 1: Invert the existing test**

`allows newlines in strings` at `packages/stream/test/json-lines.test.ts:21` asserts the behavior being removed. Replace it entirely with:

```ts
  test('rejects a raw newline inside a string', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('{"foo": "bar\nbaz"}\n')
    controller.enqueue('{"ok":true}\n')
    controller.close()

    // A raw newline in a string literal is invalid JSON: report it, do not repair it
    await expect(result).resolves.toEqual([{ ok: true }])
    expect(onInvalidJSON).toHaveBeenCalledWith(
      '{"foo": "bar',
      expect.any(TransformStreamDefaultController),
    )
  })
```

- [ ] **Step 2: Add the stale-escape regression test**

This is the bug the old repair path hid: a buffered string ending in a backslash left `isEscapingChar` true, because the fabricated `\n` bypassed `processChar`. Append inside `describe('fromJSONLines()')`:

```ts
  test('rejects a raw newline after a trailing backslash in a string', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('{"foo": "bar\\\nbaz"}\n')
    controller.enqueue('{"ok":true}\n')
    controller.close()

    await expect(result).resolves.toEqual([{ ok: true }])
    expect(onInvalidJSON).toHaveBeenCalledWith(
      '{"foo": "bar\\',
      expect.any(TransformStreamDefaultController),
    )
  })
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd packages/stream && pnpm exec vitest run test/json-lines.test.ts -t 'raw newline'
```

Expected: both FAIL. The framer fabricates a `\n` into the string and decodes `{ foo: 'bar\nbaz' }`, so `result` is `[{ foo: 'bar\nbaz' }, { ok: true }]` and `onInvalidJSON` is never called.

- [ ] **Step 4: Reject instead of repairing**

In `packages/stream/src/json-lines.ts`, delete the `else if (isInString)` branch from the `transform` callback and route the case through `invalidate`. The `transform` loop body becomes:

```ts
        while (newLineIndex !== -1) {
          const line = input.slice(0, newLineIndex)
          input = input.slice(newLineIndex + SEPARATOR.length)
          if (feedLine(line, controller)) {
            checkBufferSize()
            if (isInString) {
              // A raw newline inside a string literal is invalid JSON. Report it rather than
              // fabricating escape content that never arrived on the wire.
              invalidate(controller)
            } else if (nestingDepth === 0 && hasContent) {
              checkOutputSize()
              emit(controller)
            } else if (nestingDepth === 0) {
              // Whitespace-only line: clear it so it cannot carry into the next message
              resetFramer()
            }
          }
          newLineIndex = input.indexOf(SEPARATOR)
        }
```

Make `flush` consistent — a message truncated mid-string or mid-object at end of input is corrupt, and now says so:

```ts
    (controller) => {
      // No checkBufferSize() here: every chunk already passed the cap in the
      // transform callback, and flush only appends the decoder's pending
      // multibyte remainder (bounded) before emitting the final buffered value.
      input += decoder.decode()
      if (!feedLine(input, controller)) {
        return
      }
      if (isInString || nestingDepth > 0) {
        invalidate(controller)
      } else if (hasContent) {
        checkOutputSize()
        emit(controller)
      }
    },
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/stream && pnpm exec vitest run test/json-lines.test.ts
```

Expected: PASS, 20 tests.

`rejects a raw newline inside a string` produces two `onInvalidJSON` calls, not one: the first for `{"foo": "bar` at the newline, the second at flush for the orphaned `baz"}` tail (which opens a string at its `"` and never closes it). `toHaveBeenCalledWith` asserts *some* call matched, so the test passes as written. Do not tighten it to `toHaveBeenCalledTimes(1)`.

- [ ] **Step 6: Verify nothing else regressed**

```bash
cd packages/stream && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.test.json
```

Expected: all suites PASS, no type errors.

- [ ] **Step 7: Lint and commit**

```bash
cd packages/stream && pnpm exec biome check --write src test
cd ../.. && git add packages/stream/src/json-lines.ts packages/stream/test/json-lines.test.ts
git commit -m "fix(stream): json-lines rejects raw newlines inside strings

The repair path fabricated escape content that never arrived and bypassed
processChar, leaving isEscapingChar stale when the buffered string ended in a
backslash. A raw newline in a string literal is invalid JSON, so it now takes
the same recovery path as an unbalanced bracket. Truncated messages at flush
report as invalid too, rather than being dropped in silence."
```

---

### Task 8: Type `decode` as `DecodeJSON<T>`

**Files:**
- Modify: `packages/stream/src/json-lines.ts:23-26`
- Test: `packages/stream/test/json-lines.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FromJSONLinesOptions<T>` with `decode?: DecodeJSON<T>`.

- [ ] **Step 1: Write the failing test**

A caller passing a custom `decode` should get `T` inferred from it, with no cast at the call site. Append inside `describe('fromJSONLines()')`:

```ts
  test('infers the message type from a custom decode', async () => {
    type Message = { kind: string }
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink<Message>()

    const decode = (value: string): Message => JSON.parse(value) as Message
    source.pipeThrough(fromJSONLines({ decode })).pipeTo(sink)

    controller.enqueue('{"kind":"ping"}\n')
    controller.close()

    await expect(result).resolves.toEqual([{ kind: 'ping' }])
  })
```

- [ ] **Step 2: Run the type check to verify it fails**

```bash
cd packages/stream && pnpm exec tsc --noEmit -p tsconfig.test.json
```

Expected: FAIL. `decode` is declared `DecodeJSON<unknown>`, so `T` cannot be inferred from it and defaults to `unknown`; `pipeTo(sink)` then errors with `Type 'ReadableStream<unknown>' is not assignable to ... ReadableStream<Message>`.

- [ ] **Step 3: Change the type**

In `packages/stream/src/json-lines.ts`, change `FromJSONLinesOptions`:

```ts
export type FromJSONLinesOptions<T = unknown> = FramingLimits & {
  /**
   * Decode one framed message. A custom implementation asserts the result is `T`; the framer
   * performs no validation of its own.
   */
  decode?: DecodeJSON<T>
  onInvalidJSON?: (value: string, controller: TransformStreamDefaultController<T>) => void
}
```

The default `decode = JSON.parse` still assigns: `JSON.parse` returns `any`, which satisfies `(value: string) => T`.

- [ ] **Step 4: Run the type check and the suite to verify they pass**

```bash
cd packages/stream && pnpm exec tsc --noEmit -p tsconfig.test.json && pnpm exec vitest run test/json-lines.test.ts
```

Expected: no type errors; PASS, 21 tests.

- [ ] **Step 5: Verify the whole package and its downstream contract**

```bash
cd packages/stream && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.test.json && pnpm exec tsc --emitDeclarationOnly --skipLibCheck
```

Expected: all suites PASS, no type errors, declarations emit.

- [ ] **Step 6: Lint and commit**

```bash
cd packages/stream && pnpm exec biome check --write src test
cd ../.. && git add packages/stream/src/json-lines.ts packages/stream/test/json-lines.test.ts
git commit -m "fix(stream): type json-lines decode as DecodeJSON<T>

The result was asserted as T while the callback was typed to return unknown.
A caller supplying decode now declares the return type, so the assertion sits
with the only code able to justify it."
```

---

## Verification

After Task 8, from the repository root:

```bash
pnpm exec biome check packages/stream
cd packages/stream && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.test.json
```

Every success criterion from the spec, and the task that proves it:

| Criterion | Proven by |
|-----------|-----------|
| Abort rejects the peer's pending read with the abort reason | Task 2, Task 4 |
| Cancel rejects the peer's next write with the cancel reason | Task 2, Task 4 |
| `highWaterMark: n` parks writes past capacity, resumes on read | Task 3, Task 4 |
| Without `highWaterMark`, behavior is unchanged from `0.1.0` | Task 3, step 1 (`without highWaterMark, writes settle with no reader attached`) |
| `drain()` then `writer.close()` resolves | Task 1 |
| A stray closing bracket costs one message; the next line decodes | Task 6 |
| `pnpm test` passes in `packages/stream` | Every task, steps 5-6 |

## Deferred

Not in this plan, and deliberately so:

- A changeset. `@sozai/stream` is pre-`1.0` and this is additive plus two bug fixes; the release decision belongs to the `infra-license-and-versioning` item.
- Any change to `createReadable`, which could take the same `ChannelOptions`. No consumer has asked, and it is not named in the audit.
