import { describe, expect, test } from 'vitest'

import { createKeyedQueue, defer } from '../src/index.js'

describe('createKeyedQueue()', () => {
  test('serialises each key, returns task results, and lets independent keys run', async () => {
    const queue = createKeyedQueue<string>()
    const gate = defer<void>()
    const started = defer<void>()
    const order: Array<number> = []
    const first = queue.run('a', async () => {
      order.push(1)
      started.resolve()
      await gate.promise
      order.push(2)
      return 'first'
    })
    const second = queue.run('a', () => {
      order.push(3)
      return Promise.resolve('second')
    })
    await started.promise
    await expect(queue.run('b', () => 'independent')).resolves.toBe('independent')
    expect(order).toEqual([1])
    gate.resolve()
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(order).toEqual([1, 2, 3])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queue.size).toBe(0)
  })

  test.each(['sync', 'async'])('a %s failure does not block the next task', async (mode) => {
    const queue = createKeyedQueue()
    const error = new Error('failed')
    const failed = queue.run('a', () => {
      if (mode === 'sync') {
        throw error
      }
      return Promise.reject(error)
    })
    const next = queue.run('a', () => 42)
    await expect(failed).rejects.toBe(error)
    await expect(next).resolves.toBe(42)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queue.size).toBe(0)
  })

  test('slots count holdings synchronously and release idempotently before their turn', async () => {
    const queue = createKeyedQueue()
    const first = queue.enter('a')
    const abandoned = queue.enter('a')
    const next = queue.enter('a')
    expect(first.free).toBe(true)
    expect(abandoned.free).toBe(false)
    abandoned.release()
    abandoned.release()
    const independent = queue.enter('b')
    expect(independent.free).toBe(true)
    independent.release()
    first.release()
    const busy = queue.enter('a')
    expect(busy.free).toBe(false)
    busy.release()
    await next.turn
    next.release()
    const free = queue.enter('a')
    expect(free.free).toBe(true)
    free.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queue.size).toBe(0)
  })

  test('only a drained tail removes its key', async () => {
    const queue = createKeyedQueue()
    const first = queue.enter('a')
    const second = queue.enter('a')
    first.release()
    await second.turn
    expect(queue.size).toBe(1)
    const third = queue.enter('a')
    second.release()
    await third.turn
    expect(queue.size).toBe(1)
    third.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queue.size).toBe(0)
  })
})
