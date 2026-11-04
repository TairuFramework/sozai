import { afterEach, expect, test, vi } from 'vitest'

import { apiKeyAuth, bearerAuth, createHTTPClient, HTTPClientError } from '../src/index.js'
import type { RequestPolicy } from '../src/types.js'
import { createFakeFetch } from './helpers.js'

const policy: RequestPolicy = {
  origins: ['https://api.example.com'],
  retry: { attempts: 1, baseDelayMS: 0, maxDelayMS: 0 },
}
const url = 'https://api.example.com/items'

afterEach(() => vi.unstubAllGlobals())

test('sends a GET with auth and manual redirects', async () => {
  const fetch = createFakeFetch(() => new Response('ok'))
  const client = createHTTPClient({ policy, fetch, auth: bearerAuth('t') })
  const headers = { 'x-a': '1' }
  await client.request({ url, headers })
  expect(fetch.calls).toHaveLength(1)
  expect(fetch.calls[0]).toEqual({
    url,
    init: {
      method: 'GET',
      headers: { authorization: 'Bearer t', 'x-a': '1' },
      body: undefined,
      signal: expect.any(AbortSignal),
      redirect: 'manual',
    },
  })
  expect(headers).toEqual({ 'x-a': '1' })
})

test('refuses before fetch', async () => {
  const fetch = createFakeFetch(() => new Response())
  const client = createHTTPClient({ policy, fetch })
  await expect(client.request({ url: 'https://evil.example/' })).rejects.toMatchObject({
    code: 'ORIGIN_REFUSED',
    sent: false,
  })
  expect(fetch.calls).toHaveLength(0)
})

test('validates policy at creation', () => {
  expect(() => createHTTPClient({ policy: { origins: [] } })).toThrow(TypeError)
})

test('the auth applier overrides a caller authorization header', async () => {
  const fetch = createFakeFetch(() => new Response())
  const client = createHTTPClient({ policy, fetch, auth: bearerAuth('t') })
  await client.request({ url, headers: { Authorization: 'caller' } })
  expect(fetch.calls[0]?.init.headers).toEqual({ authorization: 'Bearer t' })
})

test('does not mutate the caller URL', async () => {
  const fetch = createFakeFetch(() => new Response())
  const client = createHTTPClient({
    policy,
    fetch,
    auth: apiKeyAuth({ in: 'query', name: 'key', value: 'k' }),
  })
  const callerURL = new URL(url)
  const href = callerURL.href
  const response = await client.request({ url: callerURL })
  expect(callerURL.href).toBe(href)
  expect(fetch.calls[0]?.url).toBe('https://api.example.com/items?key=k')
  expect(response.url).toBe(url)
})

test('serializes json bodies', async () => {
  const fetch = createFakeFetch(() => new Response())
  const client = createHTTPClient({ policy, fetch })
  await client.request({ url, method: 'post', json: { a: 1 } })
  expect(fetch.calls[0]?.init).toMatchObject({
    method: 'POST',
    body: '{"a":1}',
    headers: { 'content-type': 'application/json' },
  })
  await client.request({
    url,
    json: { a: 1 },
    headers: { 'Content-Type': 'application/merge-patch+json' },
  })
  expect(fetch.calls[1]?.init.headers).toEqual({
    'content-type': 'application/merge-patch+json',
  })
})

test('rejects json with body', async () => {
  const fetch = createFakeFetch(() => new Response())
  const client = createHTTPClient({ policy, fetch })
  await expect(client.request({ url, json: null, body: 'body' })).rejects.toBeInstanceOf(TypeError)
  expect(fetch.calls).toHaveLength(0)
})

test.each(['raw', new Uint8Array([1, 2])])('passes a raw body through: %s', async (body) => {
  const fetch = createFakeFetch(() => new Response())
  await createHTTPClient({ policy, fetch }).request({ url, method: 'put', body })
  expect(fetch.calls[0]?.init.body).toBe(body)
  expect(fetch.calls[0]?.init.method).toBe('PUT')
})

test('returns non-2xx responses', async () => {
  const fetch = createFakeFetch(
    () => new Response('missing', { status: 404, statusText: 'Not Found' }),
  )
  const response = await createHTTPClient({ policy, fetch }).request({ url })
  expect(response.status).toBe(404)
  expect(response.statusText).toBe('Not Found')
  expect(response.ok).toBe(false)
  expect(response.text()).toBe('missing')
})

test('exposes the buffered body', async () => {
  const fetch = createFakeFetch(() => new Response('{"a":1}', { headers: { 'x-result': 'yes' } }))
  const response = await createHTTPClient({ policy, fetch }).request({ url })
  expect(response.ok).toBe(true)
  expect(response.statusText).toBe('')
  expect(response.headers.get('x-result')).toBe('yes')
  expect(response.bytes()).toBe(response.bytes())
  expect(response.bytes()).toEqual(new TextEncoder().encode('{"a":1}'))
  expect(response.json<{ a: number }>()).toEqual({ a: 1 })
})

test('wraps fetch rejections', async () => {
  const cause = new Error('offline')
  const fetch = createFakeFetch(() => {
    throw cause
  })
  await expect(createHTTPClient({ policy, fetch }).request({ url })).rejects.toMatchObject({
    code: 'NETWORK',
    sent: true,
    cause,
  })
  expect(fetch.calls).toHaveLength(1)
})

test('propagates auth applier errors unwrapped', async () => {
  const cause = new Error('no token')
  const fetch = createFakeFetch(() => new Response())
  const client = createHTTPClient({
    policy,
    fetch,
    auth: () => {
      throw cause
    },
  })
  await expect(client.request({ url })).rejects.toBe(cause)
  expect(fetch.calls).toHaveLength(0)
})

test('client.json parses ok responses and sets accept', async () => {
  const fetch = createFakeFetch(() => new Response('{"a":1}'))
  const client = createHTTPClient({ policy, fetch })
  expect(await client.json<{ a: number }>({ url })).toEqual({ a: 1 })
  expect(fetch.calls[0]?.init.headers).toEqual({ accept: 'application/json' })
  await client.json({ url, headers: { Accept: 'application/custom+json' } })
  expect(fetch.calls[1]?.init.headers).toEqual({ accept: 'application/custom+json' })
})

test('client.json throws STATUS on !ok', async () => {
  const fetch = createFakeFetch(() => new Response('broken', { status: 500 }))
  const client = createHTTPClient({ policy, fetch })
  const error = await client.json({ url }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(HTTPClientError)
  expect(error).toMatchObject({ code: 'STATUS', status: 500, sent: true })
  if (!(error instanceof HTTPClientError)) throw new Error('Expected HTTPClientError')
  expect(error.response?.text()).toBe('broken')
})

test('enforces the response cap through the client', async () => {
  const fetch = createFakeFetch(() => new Response('too big'))
  const client = createHTTPClient({ policy: { ...policy, maxResponseBytes: 3 }, fetch })
  await expect(client.request({ url })).rejects.toMatchObject({
    code: 'RESPONSE_TOO_LARGE',
    sent: true,
    status: 200,
  })
  expect(fetch.calls).toHaveLength(1)
})

test('uses the runtime fetch and resolves global fetch at call time', async () => {
  const client = createHTTPClient({ policy })
  const fetch = createFakeFetch(() => new Response('runtime'))
  vi.stubGlobal('fetch', fetch)
  expect((await client.request({ url })).text()).toBe('runtime')
  expect(fetch.calls).toHaveLength(1)
})

test('does not apply auth when the first target is refused', async () => {
  const auth = vi.fn()
  const fetch = createFakeFetch(() => new Response())
  await expect(
    createHTTPClient({ policy, fetch, auth }).request({
      url: 'https://evil.example/',
    }),
  ).rejects.toMatchObject({ code: 'ORIGIN_REFUSED', sent: false })
  expect(auth).not.toHaveBeenCalled()
  expect(fetch.calls).toHaveLength(0)
})

test('omits an auth query key from the reported response URL', async () => {
  const fetch = createFakeFetch((href) => {
    const response = new Response('ok')
    Object.defineProperty(response, 'url', { value: href })
    return response
  })
  const response = await createHTTPClient({
    policy,
    fetch,
    auth: apiKeyAuth({ in: 'query', name: 'key', value: 'secret' }),
  }).request({ url: 'https://api.example.com/items?view=full' })
  expect(fetch.calls[0]?.url).toBe('https://api.example.com/items?view=full&key=secret')
  expect(response.url).toBe('https://api.example.com/items?view=full')
})
