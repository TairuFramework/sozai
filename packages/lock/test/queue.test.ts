import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { enterQueue, getQueueSize } from '../src/queue.js'

describe('enterQueue()', () => {
  test('the first caller takes its turn immediately', async () => {
    const slot = enterQueue('/tmp/sozai-queue-a.lock')
    await expect(slot.turn).resolves.toBeUndefined()
    slot.release()
  })

  test('serializes callers on the same path in FIFO order', async () => {
    const path = '/tmp/sozai-queue-b.lock'
    const order: Array<number> = []

    const run = async (id: number) => {
      const slot = enterQueue(path)
      await slot.turn
      order.push(id)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(-id)
      slot.release()
    }

    await Promise.all([run(1), run(2), run(3)])

    // Never interleaved: each entry is immediately followed by its own exit.
    expect(order).toEqual([1, -1, 2, -2, 3, -3])
  })

  test('does not serialize callers on different paths', async () => {
    const first = enterQueue('/tmp/sozai-queue-c.lock')
    const second = enterQueue('/tmp/sozai-queue-d.lock')
    await first.turn
    await expect(second.turn).resolves.toBeUndefined()
    first.release()
    second.release()
  })

  test('keys on the resolved path, so relative and absolute forms are one queue', async () => {
    const absolute = join(process.cwd(), 'sozai-queue-e.lock')
    const held = enterQueue(absolute)
    await held.turn

    const waiter = enterQueue('./sozai-queue-e.lock')
    let tookTurn = false
    void waiter.turn.then(() => {
      tookTurn = true
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(tookTurn).toBe(false)

    held.release()
    await waiter.turn
    expect(tookTurn).toBe(true)
    waiter.release()
  })

  // A caller that gives up while queued must not strand everyone behind it.
  test('releasing a slot whose turn never came lets the successor through', async () => {
    const path = '/tmp/sozai-queue-f.lock'
    const held = enterQueue(path)
    await held.turn

    const abandoned = enterQueue(path)
    const successor = enterQueue(path)

    abandoned.release()
    held.release()

    await expect(successor.turn).resolves.toBeUndefined()
    successor.release()
  })

  test('release is idempotent', async () => {
    const path = '/tmp/sozai-queue-g.lock'
    const slot = enterQueue(path)
    await slot.turn
    slot.release()
    slot.release()

    const next = enterQueue(path)
    await expect(next.turn).resolves.toBeUndefined()
    next.release()
  })

  // The try-lock's whole contract rests on this: "is this path free?" must be answerable at entry,
  // with no await at all. Deciding it by racing `turn` against a resolved promise cannot work — a
  // chain resolved with a thenable stays pending for two more microtask hops after the predecessor
  // has fully released, so a free slot reads as busy for as long as the caller's microtask depth
  // says it does.
  test('reports the slot free at entry when nobody holds the path', () => {
    const slot = enterQueue('/tmp/sozai-queue-i.lock')
    expect(slot.free).toBe(true)
    slot.release()
  })

  test('reports the slot busy at entry while a predecessor holds it', async () => {
    const path = '/tmp/sozai-queue-j.lock'
    const held = enterQueue(path)
    await held.turn

    expect(enterQueue(path).free).toBe(false)
    // The probe itself queued: release it, and the holder, so the path is clean.
    held.release()
  })

  test('reports the slot free again in the SAME tick the holder releases', async () => {
    const path = '/tmp/sozai-queue-k.lock'
    const held = enterQueue(path)
    await held.turn
    held.release()

    // No await between the release and the probe: not one microtask hop.
    const next = enterQueue(path)
    expect(next.free).toBe(true)
    await expect(next.turn).resolves.toBeUndefined()
    next.release()
  })

  test('the try-lock loop: each iteration sees the path free again', async () => {
    const path = '/tmp/sozai-queue-l.lock'
    for (let index = 0; index < 3; index++) {
      const slot = enterQueue(path)
      expect(slot.free).toBe(true)
      await slot.turn
      slot.release()
    }
  })

  test('drops its map entry once the last caller releases', async () => {
    const before = getQueueSize()
    const slot = enterQueue('/tmp/sozai-queue-h.lock')
    await slot.turn
    expect(getQueueSize()).toBe(before + 1)

    slot.release()
    // The entry is dropped asynchronously, once the tail settles.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getQueueSize()).toBe(before)
  })
})
