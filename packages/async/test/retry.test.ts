import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { TimeoutInterruption } from '../src/interruptions.js'
import {
  assertRetryPolicy,
  getRetryDelay,
  MAX_DELAY_MS,
  RetryExhaustedError,
  raceAttempt,
  retry,
} from '../src/retry.js'

describe('getRetryDelay()', () => {
  test('uses exponential growth and cap', () => {
    const policy = { maxAttempts: 4, backoff: { initialMs: 100, multiplier: 3, maxMs: 500 } }
    expect(getRetryDelay(policy, 1)).toBe(100)
    expect(getRetryDelay(policy, 2)).toBe(300)
    expect(getRetryDelay(policy, 3)).toBe(500)
  })

  test('applies full jitter using the injected random function', () => {
    const policy = { maxAttempts: 2, backoff: { initialMs: 100, jitter: true } }
    expect(getRetryDelay(policy, 1, { random: () => 0 })).toBe(0)
    expect(getRetryDelay(policy, 1, { random: () => 0.5 })).toBe(50)
    expect(getRetryDelay(policy, 1, { random: () => 1 })).toBe(100)
  })

  test('uses afterMs as a floor after jitter', () => {
    expect(
      getRetryDelay({ maxAttempts: 2, backoff: { initialMs: 100, jitter: true } }, 1, {
        random: () => 0.1,
        afterMs: 40,
      }),
    ).toBe(40)
  })

  test('saturates overflow and clamps afterMs', () => {
    expect(
      getRetryDelay({ maxAttempts: 100, backoff: { initialMs: MAX_DELAY_MS, multiplier: 2 } }, 100),
    ).toBe(MAX_DELAY_MS)
    expect(getRetryDelay({ maxAttempts: 1 }, 1, { afterMs: MAX_DELAY_MS * 2 })).toBe(MAX_DELAY_MS)
    expect(getRetryDelay({ maxAttempts: 1 }, 1, { afterMs: Number.NaN })).toBe(0)
  })
})

describe('assertRetryPolicy()', () => {
  test.each([
    [{ maxAttempts: 0 }, 'maxAttempts'],
    [{ maxAttempts: 101 }, 'maxAttempts'],
    [{ maxAttempts: 1.5 }, 'maxAttempts'],
    [{ maxAttempts: 1, attemptTimeoutMs: -1 }, 'attemptTimeoutMs'],
    [{ maxAttempts: 1, totalTimeoutMs: MAX_DELAY_MS + 1 }, 'totalTimeoutMs'],
    [{ maxAttempts: 1, backoff: { initialMs: 1.5 } }, 'initialMs'],
    [{ maxAttempts: 1, backoff: { initialMs: 1, maxMs: -1 } }, 'maxMs'],
    [{ maxAttempts: 1, backoff: { initialMs: 1, multiplier: 0.5 } }, 'multiplier'],
    [
      { maxAttempts: 1, backoff: { initialMs: 1, multiplier: Number.POSITIVE_INFINITY } },
      'multiplier',
    ],
  ] as const)('rejects invalid field %s', (policy, field) => {
    expect(() => assertRetryPolicy(policy)).toThrow(new RegExp(field))
  })
})

describe('raceAttempt()', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('enforces attempt timeout when fn ignores its signal', async () => {
    const pending = raceAttempt({ fn: () => new Promise(() => {}), timeoutMs: 25 })
    const assertion = expect(pending).rejects.toMatchObject({ cause: 'attempt' })
    await vi.advanceTimersByTimeAsync(25)
    await assertion
  })

  test('ignores late resolution', async () => {
    const pending = raceAttempt({
      fn: () => new Promise((resolve) => setTimeout(() => resolve('late'), 50)),
      timeoutMs: 10,
    })
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutInterruption)
    await vi.advanceTimersByTimeAsync(10)
    await assertion
    await vi.advanceTimersByTimeAsync(50)
  })

  test('catches late rejection of an abandoned attempt', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const pending = raceAttempt({
        fn: () => new Promise((_, reject) => setTimeout(() => reject(Error('late')), 50)),
        timeoutMs: 10,
      })
      const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutInterruption)
      await vi.advanceTimersByTimeAsync(10)
      await assertion
      await vi.advanceTimersByTimeAsync(50)
      await Promise.resolve()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  test('distinguishes deadline from attempt timeout', async () => {
    const now = Date.now
    const attempt = raceAttempt({
      fn: () => new Promise(() => {}),
      timeoutMs: 30,
      deadline: now() + 10,
      now,
    })
    const assertion = expect(attempt).rejects.toMatchObject({ cause: 'deadline' })
    await vi.advanceTimersByTimeAsync(10)
    await assertion
  })
})

describe('retry()', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('succeeds on first attempt', async () => {
    const fn = vi.fn(async () => 'ok')
    await expect(retry(fn, { policy: { maxAttempts: 3 } })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('retries and then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(Error('first')).mockResolvedValue('ok')
    const result = retry(fn, {
      policy: { maxAttempts: 2, backoff: { initialMs: 20 } },
      retryable: () => true,
    })
    await vi.advanceTimersByTimeAsync(20)
    await expect(result).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('rejects exhausted attempts with the last error as cause', async () => {
    const last = Error('last')
    const result = retry(() => Promise.reject(last), {
      policy: { maxAttempts: 2 },
      retryable: () => true,
    })
    const assertion = expect(result).rejects.toMatchObject({
      name: 'RetryExhaustedError',
      attempts: 2,
      reason: 'attempts',
      cause: last,
    })
    await vi.advanceTimersByTimeAsync(0)
    await expect(result).rejects.toBeInstanceOf(RetryExhaustedError)
    await assertion
  })

  test('rethrows non-retryable errors without wrapping', async () => {
    const error = new TypeError('no retry')
    await expect(retry(() => Promise.reject(error), { policy: { maxAttempts: 3 } })).rejects.toBe(
      error,
    )
  })

  test('honours afterMs from the retry decision', async () => {
    const fn = vi.fn().mockRejectedValueOnce(Error('again')).mockResolvedValue('ok')
    const result = retry(fn, {
      policy: { maxAttempts: 2, backoff: { initialMs: 5 } },
      retryable: () => ({ afterMs: 30 }),
    })
    await vi.advanceTimersByTimeAsync(29)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toBe('ok')
  })

  test('retries attempt timeouts by default', async () => {
    const fn = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue('ok')
    const result = retry(fn, { policy: { maxAttempts: 2, attemptTimeoutMs: 10 } })
    await vi.advanceTimersByTimeAsync(10)
    await vi.runAllTimersAsync()
    await expect(result).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('caller abort during an attempt rejects with its reason', async () => {
    const controller = new AbortController()
    const reason = Error('cancelled')
    const result = retry(() => new Promise(() => {}), {
      policy: { maxAttempts: 3 },
      signal: controller.signal,
    })
    await Promise.resolve()
    controller.abort(reason)
    await expect(result).rejects.toBe(reason)
  })

  test('caller abort during a wait rejects with its reason', async () => {
    const controller = new AbortController()
    const reason = Error('cancelled')
    const result = retry(() => Promise.reject(Error('again')), {
      policy: { maxAttempts: 3, backoff: { initialMs: 100 } },
      retryable: () => true,
      signal: controller.signal,
    })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(reason)
    await expect(result).rejects.toBe(reason)
  })

  test('enforces totalTimeoutMs and does not start a wait beyond deadline', async () => {
    const now = () => Date.now()
    const fn = vi.fn(() => new Promise(() => {}))
    const result = retry(fn, {
      policy: { maxAttempts: 3, totalTimeoutMs: 50, backoff: { initialMs: 20 } },
      now,
    })
    const assertion = expect(result).rejects.toMatchObject({
      name: 'RetryExhaustedError',
      reason: 'total_timeout',
    })
    await vi.advanceTimersByTimeAsync(50)
    await assertion
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('does not start a retry wait that would pass the total deadline', async () => {
    const error = Error('again')
    const fn = vi.fn(() => Promise.reject(error))
    const result = retry(fn, {
      policy: { maxAttempts: 3, totalTimeoutMs: 20 },
      retryable: () => ({ afterMs: 21 }),
      now: () => Date.now(),
    })
    const assertion = expect(result).rejects.toMatchObject({
      name: 'RetryExhaustedError',
      attempts: 1,
      reason: 'total_timeout',
      cause: error,
    })
    await vi.advanceTimersByTimeAsync(0)
    await assertion
    expect(fn).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('reports onRetry before each wait', async () => {
    const onRetry = vi.fn()
    const error = Error('again')
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok')
    const result = retry(fn, {
      policy: { maxAttempts: 2, backoff: { initialMs: 12 } },
      retryable: () => true,
      onRetry,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, delayMs: 12, error })
    await vi.advanceTimersByTimeAsync(12)
    await expect(result).resolves.toBe('ok')
  })

  test('validates the policy before executing', async () => {
    await expect(retry(async () => 'ok', { policy: { maxAttempts: 0 } })).rejects.toThrow(
      /maxAttempts/,
    )
  })
})
