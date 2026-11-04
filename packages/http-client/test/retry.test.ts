import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createHTTPClient, HTTPClientError } from '../src/index.js'
import { createFakeFetch, recordingSleep } from './helpers.js'

const url = 'https://api.example.com/items'
const policy = { origins: ['https://api.example.com'] }

beforeEach(() => vi.spyOn(Math, 'random').mockReturnValue(0.5))
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test('retries a GET on 503 then succeeds', async () => {
  const sleep = recordingSleep()
  const fetch = createFakeFetch(
    () => new Response('body', { status: fetch.calls.length < 3 ? 503 : 200 }),
  )
  const response = await createHTTPClient({ policy, fetch, sleep }).request({ url })
  expect(response.status).toBe(200)
  expect(sleep.delays).toEqual([125, 250])
  expect(fetch.calls).toHaveLength(3)
})

test('returns the last response when retries run out', async () => {
  const fetch = createFakeFetch(() => new Response('last body', { status: 503 }))
  const client = createHTTPClient({ policy, fetch, sleep: recordingSleep() })
  const response = await client.request({ url })
  expect(response.status).toBe(503)
  expect(response.text()).toBe('last body')
  expect(fetch.calls).toHaveLength(3)
  await expect(client.json({ url })).rejects.toMatchObject({ code: 'STATUS', status: 503 })
  expect(fetch.calls).toHaveLength(6)
})

test.each(['NETWORK', 'TIMEOUT'])('retries %s then rethrows the last error', async (code) => {
  vi.useFakeTimers()
  const causes: Array<unknown> = []
  const fetch = createFakeFetch((_url, init) => {
    if (code === 'NETWORK') {
      const cause = new TypeError(`network ${fetch.calls.length}`)
      causes.push(cause)
      throw cause
    }
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        'abort',
        () => {
          causes.push(init.signal?.reason)
          reject(init.signal?.reason)
        },
        { once: true },
      )
    })
  })
  const sleep = recordingSleep()
  const result = createHTTPClient({ policy: { ...policy, timeoutMS: 50 }, fetch, sleep })
    .request({ url })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(150)
  expect(await result).toMatchObject({ code, sent: true, cause: causes[2] })
  expect(fetch.calls).toHaveLength(3)
  expect(sleep.delays).toEqual([125, 250])
})

test.each([400, 404, 500])('does not retry other statuses: %s', async (status) => {
  const fetch = createFakeFetch(() => new Response(null, { status }))
  expect(
    (await createHTTPClient({ policy, fetch, sleep: recordingSleep() }).request({ url })).status,
  ).toBe(status)
  expect(fetch.calls).toHaveLength(1)
})

test.each([
  { method: 'POST', idempotent: undefined, attempts: 1 },
  { method: 'POST', idempotent: true, attempts: 3 },
  { method: 'GET', idempotent: false, attempts: 1 },
  { method: 'HEAD', idempotent: undefined, attempts: 3 },
])(
  'applies idempotency to $method with override $idempotent',
  async ({ method, idempotent, attempts }) => {
    const fetch = createFakeFetch(() => new Response(null, { status: 503 }))
    await createHTTPClient({ policy, fetch, sleep: recordingSleep() }).request({
      url,
      method,
      idempotent,
    })
    expect(fetch.calls).toHaveLength(attempts)
  },
)

test('does not retry a POST that timed out and reports it sent', async () => {
  vi.useFakeTimers()
  const fetch = createFakeFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }),
  )
  const result = createHTTPClient({
    policy: { ...policy, timeoutMS: 50 },
    fetch,
    sleep: recordingSleep(),
  })
    .request({ url, method: 'POST' })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(50)
  expect(await result).toMatchObject({ code: 'TIMEOUT', sent: true })
  expect(fetch.calls).toHaveLength(1)
})

test.each(['ORIGIN_REFUSED', 'TOO_MANY_REDIRECTS', 'RESPONSE_TOO_LARGE'])(
  'never retries refusals or oversize bodies: %s',
  async (code) => {
    const sleep = recordingSleep()
    const fetch = createFakeFetch(() =>
      code === 'RESPONSE_TOO_LARGE'
        ? new Response('large', { headers: { 'content-length': '100' } })
        : new Response(null, {
            status: 302,
            headers: { location: code === 'ORIGIN_REFUSED' ? 'https://other.example.com/' : url },
          }),
    )
    const client = createHTTPClient({
      policy: {
        ...policy,
        maxRedirects: code === 'TOO_MANY_REDIRECTS' ? 0 : 3,
        maxResponseBytes: 5,
      },
      fetch,
      sleep,
    })
    await expect(client.request({ url })).rejects.toMatchObject({ code })
    expect(fetch.calls).toHaveLength(1)
    expect(sleep.delays).toEqual([])
  },
)

test.each(['2', 'date'])('honours Retry-After within the cap: %s', async (value) => {
  vi.useFakeTimers()
  const now = Date.UTC(2026, 10, 4)
  vi.setSystemTime(now)
  const sleep = recordingSleep()
  const fetch = createFakeFetch(
    () =>
      new Response(null, {
        status: fetch.calls.length === 1 ? 429 : 200,
        headers: { 'retry-after': value === 'date' ? new Date(now + 3000).toUTCString() : value },
      }),
  )
  expect((await createHTTPClient({ policy, fetch, sleep }).request({ url })).status).toBe(200)
  expect(sleep.delays).toEqual([value === 'date' ? 3000 : 2000])
})

test('stops at once when Retry-After exceeds the cap', async () => {
  const sleep = recordingSleep()
  const fetch = createFakeFetch(
    () => new Response('limited', { status: 429, headers: { 'retry-after': '60' } }),
  )
  const client = createHTTPClient({ policy, fetch, sleep })
  expect((await client.request({ url })).status).toBe(429)
  expect(fetch.calls).toHaveLength(1)
  await expect(client.json({ url })).rejects.toMatchObject({
    code: 'STATUS',
    status: 429,
    retryAfterMS: 60000,
  })
  expect(fetch.calls).toHaveLength(2)
  expect(sleep.delays).toEqual([])
})

test('reports Retry-After on the final attempt', async () => {
  const fetch = createFakeFetch(
    () => new Response(null, { status: 503, headers: { 'retry-after': '1' } }),
  )
  const sleep = recordingSleep()
  await expect(createHTTPClient({ policy, fetch, sleep }).json({ url })).rejects.toMatchObject({
    code: 'STATUS',
    retryAfterMS: 1000,
  })
  expect(fetch.calls).toHaveLength(3)
  expect(sleep.delays).toEqual([1000, 1000])
})

test('restarts the redirect chain on retry', async () => {
  const fetch = createFakeFetch(
    () =>
      new Response(null, {
        status: fetch.calls.length === 1 ? 302 : fetch.calls.length === 2 ? 503 : 200,
        headers: { location: '/redirected' },
      }),
  )
  await createHTTPClient({ policy, fetch, sleep: recordingSleep() }).request({ url })
  expect(fetch.calls.map((call) => call.url)).toEqual([
    url,
    'https://api.example.com/redirected',
    url,
  ])
})

test('cancels retried response bodies without reading them', async () => {
  const cancel = vi.fn()
  const fetch = createFakeFetch(() =>
    fetch.calls.length === 1
      ? new Response(new ReadableStream({ cancel }), { status: 503 })
      : new Response('ok'),
  )
  expect(
    (await createHTTPClient({ policy, fetch, sleep: recordingSleep() }).request({ url })).text(),
  ).toBe('ok')
  expect(cancel).toHaveBeenCalledOnce()
})

test.each([new Error('auth failed'), new HTTPClientError({ code: 'NETWORK', sent: false })])(
  'never retries auth errors: %s',
  async (cause) => {
    const auth = vi.fn(() => {
      throw cause
    })
    const sleep = recordingSleep()
    await expect(createHTTPClient({ policy, auth, sleep }).request({ url })).rejects.toBe(cause)
    expect(auth).toHaveBeenCalledOnce()
    expect(sleep.delays).toEqual([])
  },
)
