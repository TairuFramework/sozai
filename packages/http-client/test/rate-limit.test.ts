import { afterEach, describe, expect, test, vi } from 'vitest'

import { createHTTPClient } from '../src/index.js'
import { createRateLimiter } from '../src/rate-limit.js'
import type { RateLimit } from '../src/types.js'
import { createFakeFetch } from './helpers.js'

function fakeClock(rateLimit: RateLimit = { requests: 2, perMS: 1000 }) {
  let t = 0
  const delays: Array<number> = []
  const limiter = createRateLimiter({
    rateLimit,
    now: () => t,
    sleep: async (ms) => {
      delays.push(ms)
      t += ms
    },
  })
  return {
    limiter,
    delays,
    advance: (ms: number) => {
      t += ms
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('token bucket', () => {
  test('serves a full bucket at once', async () => {
    const { limiter, delays } = fakeClock()
    await limiter.acquire('a.example')
    await limiter.acquire('a.example')
    expect(delays).toEqual([])
  })

  test('waits for a refill', async () => {
    const { limiter, delays } = fakeClock()
    await limiter.acquire('a.example')
    await limiter.acquire('a.example')
    await limiter.acquire('a.example')
    expect(delays).toEqual([500])
  })

  test('keeps buckets per host', async () => {
    const { limiter, delays } = fakeClock()
    for (const host of ['a.example', 'b.example']) {
      await limiter.acquire(host)
      await limiter.acquire(host)
    }
    expect(delays).toEqual([])
  })

  test('staggers concurrent waiters', async () => {
    const { limiter, delays } = fakeClock({ requests: 1, perMS: 1000 })
    await Promise.all(Array.from({ length: 3 }, () => limiter.acquire('a.example')))
    expect(delays).toEqual([1000, 2000])
  })

  test('refunds an aborted wait', async () => {
    let t = 0
    const delays: Array<number> = []
    const limiter = createRateLimiter({
      rateLimit: { requests: 1, perMS: 1000 },
      now: () => t,
      sleep: async (ms, signal) => {
        delays.push(ms)
        if (signal) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        } else t += ms
      },
    })
    await limiter.acquire('a.example')
    const parent = new AbortController()
    const cause = new Error('cancel wait')
    const waiting = limiter.acquire('a.example', parent.signal)
    const rejected = expect(waiting).rejects.toBe(cause)
    await Promise.resolve()
    parent.abort(cause)
    await rejected
    await limiter.acquire('a.example')
    expect(delays).toEqual([1000, 1000])
  })

  test('refills continuously and caps idle buckets at capacity', async () => {
    const { limiter, delays, advance } = fakeClock()
    await limiter.acquire('a.example')
    await limiter.acquire('a.example')
    advance(250)
    await limiter.acquire('a.example')
    expect(delays).toEqual([250])
    advance(10_000)
    await limiter.acquire('a.example')
    await limiter.acquire('a.example')
    await limiter.acquire('a.example')
    expect(delays).toEqual([250, 500])
  })

  test('does not reserve for an already aborted signal', async () => {
    const { limiter, delays } = fakeClock({ requests: 1, perMS: 1000 })
    const parent = new AbortController()
    const cause = new Error('already aborted')
    parent.abort(cause)
    await expect(limiter.acquire('a.example', parent.signal)).rejects.toBe(cause)
    await limiter.acquire('a.example')
    expect(delays).toEqual([])
  })
})

const url = 'https://a.example/items'
const policy = {
  origins: ['https://a.example', 'https://a.example:8443', 'https://b.example'],
  rateLimit: { requests: 1, perMS: 1000 },
  retry: { attempts: 1, baseDelayMS: 0, maxDelayMS: 0 },
}

function clientClock() {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const delays: Array<number> = []
  const sleep = async (ms: number) => {
    delays.push(ms)
    await vi.advanceTimersByTimeAsync(ms)
  }
  return { sleep, delays }
}

test('rate limits requests per host', async () => {
  const { sleep, delays } = clientClock()
  const fetch = createFakeFetch(() => new Response('ok'))
  const client = createHTTPClient({ policy, fetch, sleep })
  await client.request({ url })
  await client.request({ url })
  expect(delays).toEqual([1000])
  expect(fetch.calls).toHaveLength(2)
})

test('takes a token per redirect hop', async () => {
  const { sleep, delays } = clientClock()
  const fetch = createFakeFetch(() =>
    fetch.calls.length === 1
      ? new Response(null, { status: 302, headers: { location: '/next' } })
      : new Response('ok'),
  )
  await createHTTPClient({ policy, fetch, sleep }).request({ url })
  expect(delays).toEqual([1000])
  expect(fetch.calls.map((call) => call.url)).toEqual([url, 'https://a.example/next'])
})

test('does not count the rate-limit wait toward the timeout', async () => {
  const { sleep, delays } = clientClock()
  const fetch = createFakeFetch(() => new Response('ok'))
  const client = createHTTPClient({ policy: { ...policy, timeoutMS: 50 }, fetch, sleep })
  await client.request({ url })
  expect((await client.request({ url })).text()).toBe('ok')
  expect(delays).toEqual([1000])
  expect(vi.getTimerCount()).toBe(0)
})

test('reports an abort during the rate-limit wait as not sent', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const fetch = createFakeFetch(() => new Response('ok'))
  const parent = new AbortController()
  const cause = new Error('cancel request')
  const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
    const waiting = new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    parent.abort(cause)
    await waiting
  })
  const client = createHTTPClient({ policy, fetch, sleep })
  await client.request({ url })
  await expect(client.request({ url, signal: parent.signal })).rejects.toMatchObject({
    code: 'ABORTED',
    sent: false,
    cause,
  })
  expect(fetch.calls).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

test('takes tokens for retry attempts and their redirect hops', async () => {
  const { sleep, delays } = clientClock()
  const fetch = createFakeFetch(() => {
    if (fetch.calls.length % 2 === 1) {
      return new Response(null, { status: 302, headers: { location: '/next' } })
    }
    return new Response('ok', { status: fetch.calls.length === 2 ? 503 : 200 })
  })
  await createHTTPClient({
    policy: { ...policy, retry: { attempts: 2, baseDelayMS: 0, maxDelayMS: 0 } },
    fetch,
    sleep,
  }).request({ url })
  expect(delays).toEqual([1000, 0, 1000, 1000])
  expect(fetch.calls).toHaveLength(4)
})

test('uses separate buckets for ports, hosts and client instances', async () => {
  const { sleep, delays } = clientClock()
  const fetch = createFakeFetch(() => new Response('ok'))
  const client = createHTTPClient({ policy, fetch, sleep })
  await client.request({ url })
  await client.request({ url: 'https://a.example:8443/' })
  await client.request({ url: 'https://b.example/' })
  await createHTTPClient({ policy, fetch, sleep }).request({ url })
  expect(delays).toEqual([])
})

test('keeps the attempt timer running during redirect waits', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const fetch = createFakeFetch(
    () => new Response(null, { status: 302, headers: { location: '/next' } }),
  )
  const result = createHTTPClient({ policy: { ...policy, timeoutMS: 50 }, fetch })
    .request({ url })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(50)
  expect(await result).toMatchObject({ code: 'TIMEOUT', sent: true })
  expect(fetch.calls).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})
