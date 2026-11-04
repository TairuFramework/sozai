import { expect, test } from 'vitest'

import type { HTTPResponse } from '../src/index.js'
import { HTTPClientError } from '../src/index.js'

test('carries code, sent, status, retryAfterMS, response and cause', () => {
  const cause = new Error('boom')
  const error = new HTTPClientError({
    code: 'STATUS',
    sent: true,
    status: 429,
    retryAfterMS: 2000,
    cause,
  })
  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe('HTTPClientError')
  expect([error.code, error.sent, error.status, error.retryAfterMS, error.cause]).toEqual([
    'STATUS',
    true,
    429,
    2000,
    cause,
  ])
})

test('defaults the message from the code', () => {
  expect(new HTTPClientError({ code: 'ORIGIN_REFUSED', sent: false }).message).toContain(
    'ORIGIN_REFUSED',
  )
})

test('preserves the response instance', () => {
  const bytes = new TextEncoder().encode('{"error":"rate limited"}')
  const response: HTTPResponse = {
    status: 429,
    statusText: 'Too Many Requests',
    ok: false,
    headers: new Headers({ 'retry-after': '2' }),
    url: 'https://example.com/',
    bytes: () => bytes,
    text: () => new TextDecoder().decode(bytes),
    json: () => JSON.parse(new TextDecoder().decode(bytes)),
  }
  const error = new HTTPClientError({ code: 'STATUS', sent: true, response })
  expect(error.response).toBe(response)
})

test.each(['request refused', ''])('preserves the explicit message %j', (message) => {
  const error = new HTTPClientError({ code: 'ORIGIN_REFUSED', sent: false, message })
  expect(error.message).toBe(message)
})

test('leaves omitted optional details undefined and preserves sent false', () => {
  const error = new HTTPClientError({ code: 'ORIGIN_REFUSED', sent: false })
  expect(error.sent).toBe(false)
  expect([error.status, error.retryAfterMS, error.response, error.cause]).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ])
})
