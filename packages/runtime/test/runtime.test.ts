import { describe, expect, test, vi } from 'vitest'

import { createRuntime } from '../src/index.js'

describe('createRuntime', () => {
  test('createRuntime clocks default to Date.now and performance.now at call time', () => {
    const runtime = createRuntime()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      expect(runtime.now()).toBe(1_700_000_000_000)
    } finally {
      spy.mockRestore()
    }
    const before = performance.now()
    expect(runtime.monotonicNow()).toBeGreaterThanOrEqual(before)
  })

  test('createRuntime keeps injected clocks', () => {
    const runtime = createRuntime({ now: () => 5, monotonicNow: () => 7 })
    expect([runtime.now(), runtime.monotonicNow()]).toEqual([5, 7])
  })

  test('default monotonicNow delegates to performance.now at call time', () => {
    const runtime = createRuntime()
    const spy = vi.spyOn(performance, 'now').mockReturnValue(7)
    try {
      expect(runtime.monotonicNow()).toBe(7)
    } finally {
      spy.mockRestore()
    }
  })

  test('returns a fully resolved Runtime with defaults', () => {
    const runtime = createRuntime()
    expect(typeof runtime.fetch).toBe('function')
    expect(typeof runtime.getRandomID).toBe('function')
    expect(typeof runtime.getRandomValues).toBe('function')
  })

  test('default getRandomID returns a UUID string', () => {
    const runtime = createRuntime()
    const id = runtime.getRandomID()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('default getRandomID returns unique values', () => {
    const runtime = createRuntime()
    const ids = new Set(Array.from({ length: 10 }, () => runtime.getRandomID()))
    expect(ids.size).toBe(10)
  })

  test('default getRandomValues fills a Uint8Array', () => {
    const runtime = createRuntime()
    const array = new Uint8Array(16)
    const result = runtime.getRandomValues(array)
    expect(result).toBe(array)
    // Extremely unlikely all 16 bytes are zero
    expect(array.some((b) => b !== 0)).toBe(true)
  })

  test('overrides replace individual defaults', () => {
    let counter = 0
    const runtime = createRuntime({
      getRandomID: () => `custom-${++counter}`,
    })
    expect(runtime.getRandomID()).toBe('custom-1')
    expect(runtime.getRandomID()).toBe('custom-2')
    // Other defaults still work
    expect(typeof runtime.fetch).toBe('function')
    expect(typeof runtime.getRandomValues).toBe('function')
  })

  test('overridden fetch is used instead of globalThis.fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('mock'))
    const runtime = createRuntime({ fetch: mockFetch })

    await runtime.fetch('https://example.com')
    expect(mockFetch).toHaveBeenCalledWith('https://example.com')
  })

  test('default fetch delegates to globalThis.fetch at call time', async () => {
    const runtime = createRuntime()
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('spied'))

    try {
      const response = await runtime.fetch('https://example.com')
      expect(spy).toHaveBeenCalledWith('https://example.com')
      expect(await response.text()).toBe('spied')
    } finally {
      spy.mockRestore()
    }
  })

  test('default getRandomID delegates to globalThis.crypto at call time', () => {
    const runtime = createRuntime()
    const spy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('mocked-uuid' as `${string}-${string}-${string}-${string}-${string}`)

    try {
      expect(runtime.getRandomID()).toBe('mocked-uuid')
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })
})
