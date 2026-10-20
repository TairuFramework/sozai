import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { firstInOrder, mapConcurrent, prefetchOrdered, sleep } from '../src/index.js'

const unhandled: Array<unknown> = []
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason)
}

beforeEach(() => {
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
})

afterEach(async () => {
  await sleep(5)
  process.off('unhandledRejection', onUnhandled)
  expect(unhandled).toEqual([])
})

function tracker() {
  let current = 0
  let max = 0
  return {
    get max() {
      return max
    },
    async run<T>(delay: number, value: T, signal?: AbortSignal): Promise<T> {
      current++
      max = Math.max(max, current)
      try {
        await sleep(delay, signal)
        return value
      } finally {
        current--
      }
    },
  }
}

describe('mapConcurrent', () => {
  test('preserves input order with out-of-order completion and respects limit', async () => {
    const t = tracker()
    const delays = [30, 5, 20, 1, 10, 2]
    const result = await mapConcurrent(delays, (d, i) => t.run(d, i), { limit: 3 })
    expect(result).toEqual([0, 1, 2, 3, 4, 5])
    expect(t.max).toBe(3)
  })

  test('handles empty input and iterables', async () => {
    await expect(mapConcurrent([], async () => 1, { limit: 2 })).resolves.toEqual([])
    const set = new Set([1, 2, 3])
    await expect(mapConcurrent(set, async (n) => n * 2, { limit: 2 })).resolves.toEqual([2, 4, 6])
  })

  test('rejects invalid limit', async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(mapConcurrent([1], async () => 1, { limit })).rejects.toBeInstanceOf(RangeError)
    }
  })

  test('fail-fast aborts siblings, starts no new calls and rejects with first error', async () => {
    const started: Array<number> = []
    const aborted: Array<number> = []
    const boom = new Error('boom')
    const promise = mapConcurrent(
      [0, 1, 2, 3, 4, 5],
      async (n, _i, signal) => {
        started.push(n)
        if (n === 1) {
          await sleep(5)
          throw boom
        }
        try {
          await sleep(200, signal)
        } catch (error) {
          aborted.push(n)
          throw error
        }
        return n
      },
      { limit: 3 },
    )
    await expect(promise).rejects.toBe(boom)
    expect(started).toEqual([0, 1, 2])
    expect(aborted.sort()).toEqual([0, 2])
  })

  test('waits for in-flight calls to settle before rejecting', async () => {
    let finished = false
    const promise = mapConcurrent(
      [0, 1],
      async (n) => {
        if (n === 0) {
          throw new Error('fail')
        }
        await sleep(20)
        finished = true
      },
      { limit: 2 },
    )
    await expect(promise).rejects.toThrow('fail')
    expect(finished).toBe(true)
  })

  test('outer abort rejects with reason and stops new calls', async () => {
    const controller = new AbortController()
    const started: Array<number> = []
    const reason = new Error('stop')
    const promise = mapConcurrent(
      [0, 1, 2, 3],
      async (n, _i, signal) => {
        started.push(n)
        await sleep(100, signal)
        return n
      },
      { limit: 2, signal: controller.signal },
    )
    await sleep(5)
    controller.abort(reason)
    await expect(promise).rejects.toBe(reason)
    expect(started).toEqual([0, 1])
  })

  test('already aborted signal starts nothing', async () => {
    const started: Array<number> = []
    const reason = new Error('early')
    await expect(
      mapConcurrent(
        [1, 2],
        async (n) => {
          started.push(n)
        },
        { limit: 2, signal: AbortSignal.abort(reason) },
      ),
    ).rejects.toBe(reason)
    expect(started).toEqual([])
  })

  test('synchronous throw rejects', async () => {
    await expect(
      mapConcurrent(
        [1],
        () => {
          throw new Error('sync')
        },
        { limit: 1 },
      ),
    ).rejects.toThrow('sync')
  })
})

describe('firstInOrder', () => {
  test('waits for earlier items and prefers list order over completion order', async () => {
    const t = tracker()
    const result = await firstInOrder(
      ['slow', 'fast'],
      (item) => t.run(item === 'slow' ? 30 : 1, item),
      { limit: 2 },
    )
    expect(result).toBe('slow')
  })

  test('earlier miss lets a later hit win; later items are aborted', async () => {
    const aborted: Array<number> = []
    const result = await firstInOrder(
      [0, 1, 2],
      async (n, _i, signal) => {
        if (n === 0) {
          await sleep(10)
          return null
        }
        if (n === 1) {
          await sleep(2)
          return 'one'
        }
        try {
          await sleep(200, signal)
        } catch (error) {
          aborted.push(n)
          throw error
        }
        return 'two'
      },
      { limit: 3 },
    )
    expect(result).toBe('one')
    expect(aborted).toEqual([2])
  })

  test('rejections count as misses', async () => {
    const result = await firstInOrder(
      [0, 1, 2],
      async (n) => {
        if (n === 0) throw new Error('x')
        if (n === 1) return undefined
        return 'two'
      },
      { limit: 2 },
    )
    expect(result).toBe('two')
  })

  test('resolves null when all miss; rejects AggregateError when all reject', async () => {
    await expect(firstInOrder([1, 2], async () => null, { limit: 2 })).resolves.toBeNull()
    await expect(firstInOrder([], async () => 1, { limit: 2 })).resolves.toBeNull()
    const error = await firstInOrder(
      [0, 1],
      async (n) => {
        throw new Error(`e${n}`)
      },
      { limit: 1 },
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual(['e0', 'e1'])
    await expect(
      firstInOrder(
        [0, 1],
        async (n) => {
          if (n === 0) throw new Error('e')
          return null
        },
        { limit: 2 },
      ),
    ).resolves.toBeNull()
  })

  test('limit bounds concurrency and items past a hit are not started', async () => {
    const t = tracker()
    const started: Array<number> = []
    const result = await firstInOrder(
      [0, 1, 2, 3, 4, 5],
      async (n) => {
        started.push(n)
        return n === 1 ? t.run(5, 'hit') : t.run(20, null)
      },
      { limit: 2 },
    )
    expect(result).toBe('hit')
    expect(t.max).toBe(2)
    expect(started).toEqual([0, 1])
  })

  test('outer abort rejects with reason and aborts items', async () => {
    const controller = new AbortController()
    const reason = new Error('stop')
    let itemAborted = false
    const promise = firstInOrder(
      [0],
      async (_n, _i, signal) => {
        try {
          await sleep(200, signal)
        } catch (error) {
          itemAborted = true
          throw error
        }
        return 'x'
      },
      { limit: 1, signal: controller.signal },
    )
    await sleep(2)
    controller.abort(reason)
    await expect(promise).rejects.toBe(reason)
    expect(itemAborted).toBe(true)
  })

  test('rejects invalid limit', async () => {
    await expect(firstInOrder([1], async () => 1, { limit: 0 })).rejects.toBeInstanceOf(RangeError)
  })
})

describe('prefetchOrdered', () => {
  test('yields in index order with out-of-order completion within window', async () => {
    const t = tracker()
    const delays = [30, 1, 15, 1, 5, 1, 1]
    const seen: Array<number> = []
    for await (const value of prefetchOrdered(delays.length, (i) => t.run(delays[i] as number, i), {
      window: 3,
    })) {
      seen.push(value)
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(t.max).toBeLessThanOrEqual(3)
    expect(t.max).toBeGreaterThan(1)
  })

  test('prefetches ahead of the consumer', async () => {
    const started: Array<number> = []
    const generator = prefetchOrdered(
      5,
      async (i) => {
        started.push(i)
        return i
      },
      { window: 3 },
    )
    await generator.next()
    expect(started).toEqual([0, 1, 2, 3])
    await generator.return(undefined)
  })

  test('zero count yields nothing', async () => {
    const values: Array<number> = []
    for await (const v of prefetchOrdered(0, async (i) => i, { window: 2 })) values.push(v)
    expect(values).toEqual([])
  })

  test('early break aborts outstanding fetches and awaits them', async () => {
    const aborted: Array<number> = []
    let settled = 0
    for await (const value of prefetchOrdered(
      6,
      async (i, signal) => {
        if (i === 0) return i
        try {
          await sleep(200, signal)
        } catch (error) {
          aborted.push(i)
          throw error
        } finally {
          settled++
        }
        return i
      },
      { window: 3 },
    )) {
      expect(value).toBe(0)
      break
    }
    expect(aborted.sort()).toEqual([1, 2, 3])
    expect(settled).toBe(3)
  })

  test('error in fetch i is thrown at i, earlier values still yielded, others aborted', async () => {
    const seen: Array<number> = []
    const boom = new Error('boom')
    let aborted = false
    const run = async () => {
      for await (const value of prefetchOrdered(
        5,
        async (i, signal) => {
          if (i === 2) {
            await sleep(2)
            throw boom
          }
          if (i === 3) {
            try {
              await sleep(200, signal)
            } catch (error) {
              aborted = true
              throw error
            }
          }
          return i
        },
        { window: 4 },
      )) {
        seen.push(value)
      }
    }
    await expect(run()).rejects.toBe(boom)
    expect(seen).toEqual([0, 1])
    expect(aborted).toBe(true)
  })

  test('failures of fetches never reached are not unhandled', async () => {
    for await (const _ of prefetchOrdered(
      3,
      async (i) => {
        if (i === 0) {
          await sleep(5)
          return 0
        }
        throw new Error(`late${i}`)
      },
      { window: 3 },
    )) {
      break
    }
  })

  test('outer abort throws reason', async () => {
    const controller = new AbortController()
    const reason = new Error('stop')
    const generator = prefetchOrdered(
      3,
      async (_i, signal) => {
        await sleep(200, signal)
        return 1
      },
      { window: 2, signal: controller.signal },
    )
    const next = generator.next()
    await sleep(2)
    controller.abort(reason)
    await expect(next).rejects.toBe(reason)
  })

  test('rejects invalid window', async () => {
    await expect(prefetchOrdered(1, async () => 1, { window: 0 }).next()).rejects.toBeInstanceOf(
      RangeError,
    )
  })
})
