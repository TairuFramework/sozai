import { expect, test, vi } from 'vitest'

import { bearerAuth, createHTTPClient } from '../src/index.js'
import type { RequestPolicy } from '../src/types.js'
import { createFakeFetch } from './helpers.js'

const policy: RequestPolicy = {
  origins: ['https://api.example.com', 'https://cdn.example.com'],
}
const url = 'https://api.example.com/a/x'

function redirect(status = 302, location = 'https://cdn.example.com/f'): Response {
  return new Response('redirect', { status, headers: { location } })
}

test('follows a redirect within origins and re-applies auth', async () => {
  const auth = vi.fn(bearerAuth('t'))
  const fetch = createFakeFetch((target) => {
    return target === url ? redirect() : new Response('ok')
  })
  const response = await createHTTPClient({ policy, fetch, auth }).request({
    url,
    headers: { 'x-caller': 'kept' },
  })
  expect(fetch.calls).toHaveLength(2)
  expect(auth).toHaveBeenCalledTimes(2)
  for (const call of fetch.calls) {
    expect(call.init.headers).toEqual({ authorization: 'Bearer t', 'x-caller': 'kept' })
    expect(call.init.redirect).toBe('manual')
  }
  expect(auth.mock.calls[0]?.[0].headers).not.toBe(auth.mock.calls[1]?.[0].headers)
  expect(auth.mock.calls[0]?.[0].url).not.toBe(auth.mock.calls[1]?.[0].url)
  expect(response.url).toBe('https://cdn.example.com/f')
  expect(response.text()).toBe('ok')
})

test('resolves a relative Location against the hop URL', async () => {
  const startURL = 'https://api.example.com/start'
  const fetch = createFakeFetch((target) => {
    if (target === startURL) return redirect(302, '/a/x')
    return target === url ? redirect(302, '../b') : new Response('ok')
  })
  const response = await createHTTPClient({ policy, fetch, auth: bearerAuth('t') }).request({
    url: startURL,
  })
  expect(fetch.calls.map((call) => call.url)).toEqual([startURL, url, 'https://api.example.com/b'])
  expect(response.url).toBe('https://api.example.com/b')
})

test.each([301, 302, 303])('switches POST to GET and drops the body on %s', async (status) => {
  const fetch = createFakeFetch((target) => {
    return target === url ? redirect(status) : new Response('ok')
  })
  await createHTTPClient({ policy, fetch, auth: bearerAuth('t') }).request({
    url,
    method: 'POST',
    json: { a: 1 },
    headers: { 'content-length': '7' },
  })
  expect(fetch.calls[0]?.init.body).toBe('{"a":1}')
  expect(fetch.calls[1]?.init).toMatchObject({
    method: 'GET',
    body: undefined,
    headers: { authorization: 'Bearer t' },
  })
  expect(new Headers(fetch.calls[1]?.init.headers).has('content-type')).toBe(false)
  expect(new Headers(fetch.calls[1]?.init.headers).has('content-length')).toBe(false)
})

test.each([
  [303, 'PUT', 'GET'],
  [303, 'HEAD', 'HEAD'],
  [301, 'PUT', 'PUT'],
  [302, 'PUT', 'PUT'],
  [307, 'POST', 'POST'],
  [308, 'POST', 'POST'],
])('redirect %s changes %s to %s', async (status, method, expectedMethod) => {
  const fetch = createFakeFetch((target) => {
    return target === url ? redirect(status) : new Response(null)
  })
  const body = method === 'HEAD' ? undefined : new Uint8Array([1, 2])
  await createHTTPClient({ policy, fetch }).request({
    url,
    method,
    body,
    headers: { 'content-type': 'application/octet-stream' },
  })
  expect(fetch.calls[1]?.init.method).toBe(expectedMethod)
  expect(fetch.calls[1]?.init.body).toBe(expectedMethod === 'GET' ? undefined : body)
  expect(new Headers(fetch.calls[1]?.init.headers).has('content-type')).toBe(
    expectedMethod !== 'GET',
  )
})

test.each([
  ['https://evil.example/', 'ORIGIN_REFUSED'],
  ['http://api.example.com/', 'INSECURE_URL'],
  ['https://u:p@api.example.com/', 'INSECURE_URL'],
])('refuses a hop to %s before applying auth', async (location, code) => {
  const fetch = createFakeFetch(() => redirect(302, location))
  const auth = vi.fn(bearerAuth('t'))
  await expect(createHTTPClient({ policy, fetch, auth }).request({ url })).rejects.toMatchObject({
    code,
    sent: true,
  })
  expect(fetch.calls).toHaveLength(1)
  expect(auth).toHaveBeenCalledTimes(1)
})

test('refuses a hop to a private address', async () => {
  const fetch = createFakeFetch(() => redirect())
  const resolveHost = vi.fn(async (host: string) => {
    return host === 'cdn.example.com' ? ['10.0.0.5'] : ['8.8.8.8']
  })
  await expect(
    createHTTPClient({ policy, fetch, resolveHost }).request({ url }),
  ).rejects.toMatchObject({ code: 'ADDRESS_REFUSED', sent: true })
  expect(fetch.calls).toHaveLength(1)
  expect(resolveHost.mock.calls).toEqual([['api.example.com'], ['cdn.example.com']])
})

test.each([undefined, 0])('stops after maxRedirects %s', async (maxRedirects) => {
  const fetch = createFakeFetch(() => redirect())
  await expect(
    createHTTPClient({ policy: { ...policy, maxRedirects }, fetch }).request({ url }),
  ).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS', sent: true })
  expect(fetch.calls).toHaveLength(maxRedirects === 0 ? 1 : 4)
})

test.each([301, 302, 303, 307, 308])('returns a %s without Location', async (status) => {
  const fetch = createFakeFetch(() => new Response('no location', { status }))
  const response = await createHTTPClient({ policy, fetch }).request({ url })
  expect(response.status).toBe(status)
  expect(response.text()).toBe('no location')
  expect(fetch.calls).toHaveLength(1)
})

test.each([
  ['https://evil.example/', false],
  ['https://cdn.example.com/f', true],
])('checks platform-followed redirects to %s', async (finalURL, allowed) => {
  const fetch = createFakeFetch(() => {
    const response = new Response('ok')
    Object.defineProperty(response, 'url', { value: finalURL })
    return response
  })
  const result = createHTTPClient({ policy, fetch }).request({ url })
  if (allowed) {
    expect((await result).url).toBe(finalURL)
  } else {
    await expect(result).rejects.toMatchObject({ code: 'ORIGIN_REFUSED', sent: true })
  }
  expect(fetch.calls).toHaveLength(1)
})

test.each([
  ['opaqueredirect', 0],
  ['opaqueredirect', 302],
  ['default', 0],
])('treats response type %s and status %s as network errors', async (type, status) => {
  const fetch = createFakeFetch(() => {
    const response = new Response(null)
    Object.defineProperties(response, { type: { value: type }, status: { value: status } })
    return response
  })
  await expect(createHTTPClient({ policy, fetch }).request({ url })).rejects.toMatchObject({
    code: 'NETWORK',
    sent: true,
  })
  expect(fetch.calls).toHaveLength(1)
})

test.each([false, true])(
  'cancels redirect bodies and ignores cancellation errors: %s',
  async (fail) => {
    const cancel = vi.fn(async () => {
      if (fail) throw new Error('cancel failed')
    })
    const fetch = createFakeFetch((target) => {
      if (target !== url) return new Response('ok')
      const response = redirect()
      Object.defineProperty(response, 'body', { value: { cancel } })
      return response
    })
    expect((await createHTTPClient({ policy, fetch }).request({ url })).text()).toBe('ok')
    expect(cancel).toHaveBeenCalledTimes(1)
  },
)

test('cancels the redirect body when the redirect limit is reached', async () => {
  const response = redirect()
  if (response.body === null) throw new Error('Expected a redirect body')
  const cancel = vi.spyOn(response.body, 'cancel')
  const fetch = createFakeFetch(() => response)
  await expect(
    createHTTPClient({ policy: { ...policy, maxRedirects: 0 }, fetch }).request({ url }),
  ).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS', sent: true })
  expect(cancel).toHaveBeenCalledTimes(1)
})
