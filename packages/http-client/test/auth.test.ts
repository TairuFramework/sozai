import { expect, test } from 'vitest'

import { apiKeyAuth, bearerAuth, noAuth } from '../src/index.js'

const target = () => ({ url: new URL('https://api.example.com/x?a=1'), headers: new Headers() })

test('bearerAuth sets the authorization header', async () => {
  const request = target()
  request.headers.set('authorization', 'old')
  await bearerAuth('t')(request)
  expect(request.headers.get('authorization')).toBe('Bearer t')
})

test('bearerAuth calls a token function on every apply', async () => {
  let calls = 0
  const auth = bearerAuth(async () => `t${++calls}`)
  const request = target()
  await auth(request)
  expect(request.headers.get('authorization')).toBe('Bearer t1')
  await auth(request)
  expect(request.headers.get('authorization')).toBe('Bearer t2')
  expect(calls).toBe(2)
})

test('bearerAuth accepts a synchronous token function', async () => {
  const request = target()
  await bearerAuth(() => 'sync')(request)
  expect(request.headers.get('authorization')).toBe('Bearer sync')
})

test('bearerAuth propagates token provider errors', async () => {
  const cause = new Error('Token unavailable')
  const request = target()
  await expect(
    bearerAuth(async () => {
      throw cause
    })(request),
  ).rejects.toBe(cause)
  expect(request.headers.has('authorization')).toBe(false)
})

test('apiKeyAuth in header', async () => {
  const request = target()
  request.headers.set('x-api-key', 'old')
  await apiKeyAuth({ in: 'header', name: 'x-api-key', value: 'k' })(request)
  expect(request.headers.get('x-api-key')).toBe('k')
})

test('apiKeyAuth in query replaces an existing parameter', async () => {
  const request = target()
  request.url.searchParams.append('key', 'old')
  request.url.searchParams.append('key', 'duplicate')
  await apiKeyAuth({ in: 'query', name: 'key', value: 'k' })(request)
  expect(request.url.searchParams.getAll('key')).toEqual(['k'])
  expect(request.url.searchParams.get('a')).toBe('1')
  expect([...request.headers]).toEqual([])
})

test.each(['header', 'query'] as const)('apiKeyAuth rejects an empty name in %s', (location) => {
  expect(() => apiKeyAuth({ in: location, name: 'key', value: 'k' })).not.toThrow()
  expect(() => apiKeyAuth({ in: location, name: '', value: 'k' })).toThrow(TypeError)
})

test('noAuth changes nothing', async () => {
  const request = target()
  const href = request.url.href
  await noAuth(request)
  expect([...request.headers]).toEqual([])
  expect(request.url.href).toBe(href)
  request.headers.set('authorization', 'existing')
  await noAuth(request)
  expect([...request.headers]).toEqual([['authorization', 'existing']])
  expect(request.url.href).toBe(href)
})
