import { describe, expect, test, vi } from 'vitest'

import { onAbort } from '../src/on-abort.js'

describe('onAbort', () => {
  test('returns a noop and never calls fn when signal is undefined', () => {
    const fn = vi.fn()
    const unsubscribe = onAbort(undefined, fn)
    unsubscribe()
    expect(fn).not.toHaveBeenCalled()
  })

  test('fires fn synchronously when the signal is already aborted', () => {
    const controller = new AbortController()
    controller.abort()
    const fn = vi.fn()
    onAbort(controller.signal, fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('fires fn once when the signal aborts later', () => {
    const controller = new AbortController()
    const fn = vi.fn()
    onAbort(controller.signal, fn)
    controller.abort()
    controller.abort()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('unsubscribe removes the listener so fn never fires', () => {
    const controller = new AbortController()
    const fn = vi.fn()
    const unsubscribe = onAbort(controller.signal, fn)
    unsubscribe()
    controller.abort()
    expect(fn).not.toHaveBeenCalled()
  })
})
