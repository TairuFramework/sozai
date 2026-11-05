import { expect, test } from 'vitest'

import { parseRetryAfter } from '../src/index.js'

test('parses Retry-After seconds and dates', () => {
  const now = Date.UTC(2026, 10, 4)
  expect(parseRetryAfter('2', now)).toBe(2000)
  expect(parseRetryAfter('0', now)).toBe(0)
  expect(parseRetryAfter(new Date(now + 3000).toUTCString(), now)).toBe(3000)
  expect(parseRetryAfter(new Date(now - 3000).toUTCString(), now)).toBe(0)
  for (const value of ['-1', '1.5', 'soon', null])
    expect(parseRetryAfter(value, now)).toBeUndefined()
})
