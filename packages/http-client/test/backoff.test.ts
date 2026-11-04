import { expect, test } from 'vitest'

import { getBackoffDelay, parseRetryAfter, RETRYABLE_STATUSES } from '../src/backoff.js'

test('grows exponentially with full jitter', () => {
  const retry = { attempts: 3, baseDelayMS: 250, maxDelayMS: 10_000 }
  expect(
    [1, 2, 3].map((retryIndex) => getBackoffDelay({ retry, retryIndex, random: () => 0.5 })),
  ).toEqual([125, 250, 500])
})

test('caps at maxDelayMS', () => {
  expect(
    getBackoffDelay({
      retry: { attempts: 6, baseDelayMS: 1000, maxDelayMS: 1500 },
      retryIndex: 5,
      random: () => 0.999,
    }),
  ).toBe(1498)
})

test('parses Retry-After seconds and dates', () => {
  const now = Date.UTC(2026, 10, 4)
  expect(parseRetryAfter('2', now)).toBe(2000)
  expect(parseRetryAfter('0', now)).toBe(0)
  expect(parseRetryAfter(new Date(now + 3000).toUTCString(), now)).toBe(3000)
  expect(parseRetryAfter(new Date(now - 3000).toUTCString(), now)).toBe(0)
  for (const value of ['-1', '1.5', 'soon', null])
    expect(parseRetryAfter(value, now)).toBeUndefined()
})

test('retries only the declared statuses', () => {
  expect([...RETRYABLE_STATUSES]).toEqual([429, 502, 503, 504])
})
