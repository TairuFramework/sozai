import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { linkSignal } from '../src/signal.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('linkSignal dispose stops the timer and removes the parent listener', async () => {
  const parent = new AbortController()
  const linked = linkSignal({ parent: parent.signal, timeoutMS: 50 })
  linked.dispose()
  linked.dispose()
  parent.abort(new Error('after dispose'))
  await vi.advanceTimersByTimeAsync(50)
  expect(linked.signal.aborted).toBe(false)
  expect(linked.timedOut()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

test('forwards the parent reason without classifying it as a timeout', async () => {
  const parent = new AbortController()
  const linked = linkSignal({ parent: parent.signal, timeoutMS: 50 })
  const cause = new Error('caller cancelled')
  parent.abort(cause)
  await vi.advanceTimersByTimeAsync(50)
  expect(linked.signal.reason).toBe(cause)
  expect(linked.timedOut()).toBe(false)
  linked.dispose()
})

test('forwards a pre-aborted parent synchronously', () => {
  const parent = new AbortController()
  parent.abort('already cancelled')
  const linked = linkSignal({ parent: parent.signal, timeoutMS: 50 })
  expect(linked.signal.aborted).toBe(true)
  expect(linked.signal.reason).toBe('already cancelled')
  expect(linked.timedOut()).toBe(false)
  linked.dispose()
})

test('records a timeout and preserves it after a later caller abort', async () => {
  const parent = new AbortController()
  const linked = linkSignal({ parent: parent.signal, timeoutMS: 50 })
  await vi.advanceTimersByTimeAsync(50)
  expect(linked.signal.aborted).toBe(true)
  expect(linked.timedOut()).toBe(true)
  const cause = linked.signal.reason
  parent.abort('later caller abort')
  expect(linked.signal.reason).toBe(cause)
  expect(linked.timedOut()).toBe(true)
  linked.dispose()
})
