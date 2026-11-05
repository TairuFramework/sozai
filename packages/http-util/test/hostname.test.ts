import { expect, test } from 'vitest'

import { isLoopbackHost, normalizeHostname } from '../src/index.js'

test.each([
  ['https://EXAMPLE.com./x', 'example.com'],
  ['https://[::1]:8080/', '::1'],
  ['http://127.0.0.1/', '127.0.0.1'],
])('normalizeHostname(%s) is %s', (url, expected) => {
  expect(normalizeHostname(new URL(url))).toBe(expected)
})

test.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]'])(
  'isLoopbackHost accepts %s',
  (hostname) => {
    expect(isLoopbackHost(hostname)).toBe(true)
  },
)

test.each(['example.com', 'localhost.example.com', '10.0.0.1', '::2', ''])(
  'isLoopbackHost refuses %j',
  (hostname) => {
    expect(isLoopbackHost(hostname)).toBe(false)
  },
)
