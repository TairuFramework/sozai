import { describe, expect, test, vi } from 'vitest'

import { scheduleMicrotask } from '../src/microtask.js'

describe('scheduleMicrotask', () => {
  test('defers the callback past the current synchronous frame', async () => {
    const calls: Array<string> = []

    scheduleMicrotask(() => {
      calls.push('deferred')
    })
    calls.push('sync')

    expect(calls).toEqual(['sync'])

    await Promise.resolve()
    expect(calls).toEqual(['sync', 'deferred'])
  })

  test('falls back to a promise when queueMicrotask is unavailable', async () => {
    // The helper picks its scheduler once, at module load, so the global has to be stubbed
    // before the module is (re-)imported.
    vi.stubGlobal('queueMicrotask', undefined)
    vi.resetModules()
    try {
      const { scheduleMicrotask: fallbackSchedule } = await import('../src/microtask.js')
      const calls: Array<string> = []

      fallbackSchedule(() => {
        calls.push('deferred')
      })
      calls.push('sync')

      expect(calls).toEqual(['sync'])

      // setTimeout, not Promise.resolve: the fallback is a microtask under a native Promise but a
      // macrotask under React Native's legacy Promise polyfill. Both settle before a timer.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(calls).toEqual(['sync', 'deferred'])
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })
})
