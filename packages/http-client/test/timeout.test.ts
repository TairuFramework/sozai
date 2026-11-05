import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { bearerAuth, createHTTPClient } from '../src/index.js'
import type { RequestPolicy } from '../src/types.js'
import { createFakeFetch, recordingSleep } from './helpers.js'

const url = 'https://api.example.com/items'
const policy: RequestPolicy = {
  origins: ['https://api.example.com', 'https://cdn.example.com'],
  timeoutMS: 50,
  retry: { attempts: 1, baseDelayMS: 0, maxDelayMS: 0 },
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function hangingFetch() {
  return createFakeFetch((_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  })
}

test('times out a hanging fetch', async () => {
  const fetch = hangingFetch()
  const result = createHTTPClient({ policy, fetch })
    .request({ url })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(49)
  expect(fetch.calls[0]?.init.signal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await result).toMatchObject({ code: 'TIMEOUT', sent: true })
  expect(vi.getTimerCount()).toBe(0)
})

test.each([false, true])('times out a hanging body read without stream: %s', async (noStream) => {
  const cancel = vi.fn()
  const fetch = createFakeFetch(() => {
    const response = new Response(new ReadableStream({ cancel }))
    if (noStream) {
      Object.defineProperty(response, 'body', { value: null })
      response.arrayBuffer = () => new Promise<ArrayBuffer>(() => {})
    }
    return response
  })
  const result = createHTTPClient({ policy, fetch })
    .request({ url })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(50)
  expect(await result).toMatchObject({ code: 'TIMEOUT', sent: true })
  if (!noStream) expect(cancel).toHaveBeenCalledOnce()
})

test('aborts before sending', async () => {
  const parent = new AbortController()
  const cause = new Error('cancel before send')
  parent.abort(cause)
  const fetch = hangingFetch()
  const result = createHTTPClient({ policy, fetch }).request({ url, signal: parent.signal })
  await expect(result).rejects.toMatchObject({ code: 'ABORTED', sent: false, cause })
  expect(fetch.calls).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

test('aborts in flight', async () => {
  const parent = new AbortController()
  const cause = new Error('cancel in flight')
  const fetch = hangingFetch()
  const result = createHTTPClient({ policy, fetch })
    .request({ url, signal: parent.signal })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  parent.abort(cause)
  expect(await result).toMatchObject({ code: 'ABORTED', sent: true, cause })
  expect(fetch.calls).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

test.each(['NETWORK', 'ABORTED', 'TIMEOUT'] as const)(
  'wraps reader failures as %s with the original cause',
  async (code) => {
    const parent = new AbortController()
    const cause = new Error('reader failed')
    const fetch = createFakeFetch((_url, init) => {
      return new Response(
        new ReadableStream({
          start(controller) {
            if (code === 'NETWORK') controller.error(cause)
            else
              init.signal?.addEventListener('abort', () => controller.error(cause), { once: true })
          },
        }),
      )
    })
    const result = createHTTPClient({ policy, fetch })
      .request({ url, signal: parent.signal })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(code === 'TIMEOUT' ? 50 : 0)
    if (code === 'ABORTED') parent.abort(cause)
    expect(await result).toMatchObject({ code, sent: true, cause })
  },
)

test('never calls AbortSignal.any or AbortSignal.timeout', async () => {
  const any = vi.spyOn(AbortSignal, 'any')
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  await createHTTPClient({ policy, fetch: createFakeFetch(() => new Response('ok')) }).request({
    url,
  })
  const result = createHTTPClient({ policy, fetch: hangingFetch() })
    .request({ url })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(50)
  expect(await result).toMatchObject({ code: 'TIMEOUT' })
  expect(any).not.toHaveBeenCalled()
  expect(timeout).not.toHaveBeenCalled()
})

test('shares one timeout across redirect hops and body buffering', async () => {
  const signals: Array<AbortSignal | null | undefined> = []
  const fetch = createFakeFetch(async (target, init) => {
    signals.push(init.signal)
    if (target === url) {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/' } })
    }
    return new Response(new ReadableStream())
  })
  const result = createHTTPClient({ policy, fetch })
    .request({ url })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(50)
  expect(await result).toMatchObject({ code: 'TIMEOUT', sent: true })
  expect(signals).toHaveLength(2)
  expect(signals[0]).toBe(signals[1])
})

test('aborts while checking the first target without sending or applying auth', async () => {
  const parent = new AbortController()
  const cause = new Error('cancel during DNS')
  const fetch = hangingFetch()
  const auth = vi.fn()
  const result = createHTTPClient({
    policy,
    fetch,
    auth,
    resolveHost: async () => {
      parent.abort(cause)
      return ['8.8.8.8']
    },
  }).request({ url, signal: parent.signal })
  await expect(result).rejects.toMatchObject({ code: 'ABORTED', sent: false, cause })
  expect(fetch.calls).toHaveLength(0)
  expect(auth).not.toHaveBeenCalled()
})

test('does not send when the caller aborts during auth', async () => {
  const parent = new AbortController()
  const cause = new Error('cancel during auth')
  const fetch = hangingFetch()
  await expect(
    createHTTPClient({
      policy,
      fetch,
      auth: () => parent.abort(cause),
    }).request({ url, signal: parent.signal }),
  ).rejects.toMatchObject({
    code: 'ABORTED',
    sent: false,
    cause,
  })
  expect(fetch.calls).toHaveLength(0)
})

test.each([false, true])(
  'disposes timer and parent listener after settlement, failure: %s',
  async (fail) => {
    const parent = new AbortController()
    const remove = vi.spyOn(parent.signal, 'removeEventListener')
    const cause = new Error('auth failure')
    const fetch = createFakeFetch(() => new Response('ok'))
    const result = createHTTPClient({
      policy,
      fetch,
      auth: () => {
        if (fail) throw cause
      },
    }).request({ url, signal: parent.signal })
    if (fail) await expect(result).rejects.toBe(cause)
    else expect((await result).text()).toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    parent.abort()
    if (!fail) expect(fetch.calls[0]?.init.signal?.aborted).toBe(false)
  },
)

test('uses the caller abort reason even when fetch rejects with a different error', async () => {
  const parent = new AbortController()
  const cause = new Error('caller reason')
  const fetch = createFakeFetch((_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new TypeError('fetch abort')), {
        once: true,
      })
    })
  })
  const result = createHTTPClient({ policy, fetch })
    .request({ url, signal: parent.signal })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  parent.abort(cause)
  expect(await result).toMatchObject({ code: 'ABORTED', sent: true, cause })
})

test.each([false, true])('aborts a hanging body read without stream: %s', async (noStream) => {
  const parent = new AbortController()
  const cause = new Error('cancel body')
  const cancel = vi.fn()
  let response: Response | undefined
  const fetch = createFakeFetch(() => {
    response = new Response(new ReadableStream({ cancel }))
    if (noStream) {
      Object.defineProperty(response, 'body', { value: null })
      response.arrayBuffer = () => new Promise<ArrayBuffer>(() => {})
    }
    return response
  })
  const result = createHTTPClient({ policy, fetch })
    .request({ url, signal: parent.signal })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  parent.abort(cause)
  expect(await result).toMatchObject({ code: 'ABORTED', sent: true, cause })
  if (!noStream) {
    expect(cancel).toHaveBeenCalledOnce()
    expect(response?.body?.locked).toBe(false)
  }
  expect(vi.getTimerCount()).toBe(0)
})

test('the timeout is per attempt', async () => {
  const sleep = recordingSleep()
  const fetch = createFakeFetch((_url, init) => {
    if (fetch.calls.length === 2) return new Response('ok')
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  })
  const result = createHTTPClient({
    policy: { ...policy, retry: { attempts: 2, baseDelayMS: 250, maxDelayMS: 10_000 } },
    fetch,
    sleep,
  }).request({ url })
  const settled = result.catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(50)
  expect(await settled).toMatchObject({ status: 200 })
  expect(fetch.calls).toHaveLength(2)
  expect(fetch.calls[0]?.init.signal).not.toBe(fetch.calls[1]?.init.signal)
  expect(sleep.delays).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

test('aborts during backoff', async () => {
  const parent = new AbortController()
  const cause = new Error('cancel backoff')
  const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
    const wait = new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    parent.abort(cause)
    await wait
  })
  const fetch = createFakeFetch(() => new Response(null, { status: 503 }))
  await expect(
    createHTTPClient({
      policy: { ...policy, retry: { attempts: 3, baseDelayMS: 250, maxDelayMS: 10_000 } },
      fetch,
      sleep,
    }).request({ url, signal: parent.signal }),
  ).rejects.toMatchObject({ code: 'ABORTED', sent: true, cause })
  expect(fetch.calls).toHaveLength(1)
  expect(sleep).toHaveBeenCalledWith(expect.any(Number), parent.signal)
  expect(vi.getTimerCount()).toBe(0)
})

test.each(['ABORTED', 'TIMEOUT'])(
  'maps a resolver rejection after %s before sending',
  async (code) => {
    const parent = new AbortController()
    const cause = new Error('caller cancelled DNS')
    const fetch = hangingFetch()
    const auth = vi.fn()
    const result = createHTTPClient({
      policy,
      fetch,
      auth,
      resolveHost: async () => {
        if (code === 'ABORTED') parent.abort(cause)
        else await new Promise((resolve) => setTimeout(resolve, 50))
        throw new Error('resolver rejection')
      },
    })
      .request({ url, signal: parent.signal })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(50)
    expect(await result).toMatchObject({
      code,
      sent: false,
      cause: code === 'ABORTED' ? cause : expect.any(Error),
    })
    expect(fetch.calls).toHaveLength(0)
    expect(auth).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  },
)

test.each([false, true])(
  'bounds a hung lookup after the first token, rate limit: %s',
  async (limited) => {
    const fetch = hangingFetch()
    let settled: unknown
    const result = createHTTPClient({
      policy: { ...policy, rateLimit: limited ? { requests: 1, perMS: 100 } : undefined },
      fetch,
      resolveHost: () => new Promise<Array<string>>(() => {}),
    })
      .request({ url })
      .catch((error: unknown) => {
        settled = error
      })
    await vi.advanceTimersByTimeAsync(50)
    expect(settled).toMatchObject({ code: 'TIMEOUT', sent: false })
    await result
    expect(fetch.calls).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  },
)

test('aborts a lookup that never settles', async () => {
  const parent = new AbortController()
  const cause = new Error('cancel hung lookup')
  const fetch = hangingFetch()
  let settled: unknown
  const result = createHTTPClient({
    policy,
    fetch,
    resolveHost: () => new Promise<Array<string>>(() => {}),
  })
    .request({ url, signal: parent.signal })
    .catch((error: unknown) => {
      settled = error
    })
  await vi.advanceTimersByTimeAsync(0)
  parent.abort(cause)
  await vi.advanceTimersByTimeAsync(0)
  expect(settled).toMatchObject({ code: 'ABORTED', sent: false, cause })
  await result
  expect(fetch.calls).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

test.each(['TIMEOUT', 'ABORTED'])('bounds a hung bearer token provider with %s', async (code) => {
  const parent = new AbortController()
  const fetch = hangingFetch()
  let settled: unknown
  const result = createHTTPClient({
    policy,
    fetch,
    auth: bearerAuth(() => new Promise<string>(() => {})),
  })
    .request({ url, signal: parent.signal })
    .catch((error: unknown) => {
      settled = error
    })
  await vi.advanceTimersByTimeAsync(0)
  if (code === 'ABORTED') parent.abort(new Error('cancel token provider'))
  await vi.advanceTimersByTimeAsync(50)
  expect(settled).toMatchObject({ code, sent: false })
  await result
  expect(fetch.calls).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

test('passes the attempt signal to the resolver', async () => {
  const fetch = createFakeFetch(() => new Response('ok'))
  let lookupSignal: AbortSignal | undefined
  await createHTTPClient({
    policy,
    fetch,
    resolveHost: async (_hostname, options) => {
      lookupSignal = options?.signal
      return ['8.8.8.8']
    },
  }).request({ url })
  expect(lookupSignal).toBeInstanceOf(AbortSignal)
  expect(lookupSignal).toBe(fetch.calls[0]?.init.signal)
})
