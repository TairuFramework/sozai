import { describe, expect, test, vi } from 'vitest'

// `expo-crypto` is a native module: importing it in a bare Node/vitest run fails (it drags in
// `expo-modules-core`'s TS source and a native `ExpoCrypto` binding that only exist in a native
// runtime). Mock it so the module under test loads, and so the wiring can be asserted by identity.
// vi.hoisted so these exist when the hoisted vi.mock factory runs (vi.mock is lifted above imports).
const { mockRandomUUID, mockGetRandomValues } = vi.hoisted(() => ({
  mockRandomUUID: vi.fn(() => 'mocked-uuid-value'),
  mockGetRandomValues: vi.fn(<T>(array: T): T => array),
}))
vi.mock('expo-crypto', () => ({
  randomUUID: mockRandomUUID,
  getRandomValues: mockGetRandomValues,
}))

import { createRuntime, expoRuntime, polyfill, polyfillCrypto } from '../src/index.js'

describe('expoRuntime', () => {
  test('wires getRandomID to expo-crypto randomUUID', () => {
    expect(expoRuntime.getRandomID).toBe(mockRandomUUID)
    expect(expoRuntime.getRandomID()).toBe('mocked-uuid-value')
    expect(mockRandomUUID).toHaveBeenCalledOnce()
  })

  test('wires getRandomValues to expo-crypto getRandomValues', () => {
    const array = new Uint8Array(4)
    expect(expoRuntime.getRandomValues(array)).toBe(array)
    expect(mockGetRandomValues).toHaveBeenCalledWith(array)
  })

  test('fetch delegates to globalThis.fetch at call time', async () => {
    // The regression this whole suite exists for: fetch must delegate at call time, so a spy
    // assigned to globalThis.fetch *after* the module was imported still applies.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('spied'))
    try {
      const response = await expoRuntime.fetch('https://example.com')
      expect(spy).toHaveBeenCalledWith('https://example.com', undefined)
      expect(await response.text()).toBe('spied')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('createRuntime', () => {
  test('returns a fully resolved Runtime from the expo defaults', () => {
    const runtime = createRuntime()
    expect(runtime.fetch).toBe(expoRuntime.fetch)
    expect(runtime.getRandomID).toBe(expoRuntime.getRandomID)
    expect(runtime.getRandomValues).toBe(expoRuntime.getRandomValues)
  })

  test('overrides win and omitted entries fall back to the defaults', () => {
    const customFetch = vi.fn()
    const runtime = createRuntime({ fetch: customFetch as unknown as typeof globalThis.fetch })
    expect(runtime.fetch).toBe(customFetch)
    // Omitted entries still resolve to the expo defaults.
    expect(runtime.getRandomID).toBe(expoRuntime.getRandomID)
    expect(runtime.getRandomValues).toBe(expoRuntime.getRandomValues)
  })
})

describe('polyfillCrypto', () => {
  test('installs both functions when globalThis.crypto is absent', () => {
    vi.stubGlobal('crypto', undefined)
    try {
      polyfillCrypto()
      expect(globalThis.crypto.getRandomValues).toBe(mockGetRandomValues)
      expect(globalThis.crypto.randomUUID).toBe(mockRandomUUID)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('leaves existing functions in place when override is false', () => {
    const existingGetRandomValues = vi.fn()
    const existingRandomUUID = vi.fn()
    vi.stubGlobal('crypto', {
      getRandomValues: existingGetRandomValues,
      randomUUID: existingRandomUUID,
    })
    try {
      polyfillCrypto()
      expect(globalThis.crypto.getRandomValues).toBe(existingGetRandomValues)
      expect(globalThis.crypto.randomUUID).toBe(existingRandomUUID)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('replaces existing functions when override is true', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: vi.fn(),
      randomUUID: vi.fn(),
    })
    try {
      polyfillCrypto(true)
      expect(globalThis.crypto.getRandomValues).toBe(mockGetRandomValues)
      expect(globalThis.crypto.randomUUID).toBe(mockRandomUUID)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('installs only the missing function, keeping the present one', () => {
    const existingRandomUUID = vi.fn()
    vi.stubGlobal('crypto', { randomUUID: existingRandomUUID })
    try {
      polyfillCrypto()
      expect(globalThis.crypto.getRandomValues).toBe(mockGetRandomValues)
      expect(globalThis.crypto.randomUUID).toBe(existingRandomUUID)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('polyfill', () => {
  test('delegates to polyfillCrypto', () => {
    vi.stubGlobal('crypto', undefined)
    try {
      polyfill()
      expect(globalThis.crypto.getRandomValues).toBe(mockGetRandomValues)
      expect(globalThis.crypto.randomUUID).toBe(mockRandomUUID)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// No URL type-level test: `defaultFetch` spells its signature out to survive React Native's
// narrowing `fetch` overload, but `react-native` is not installed in this workspace (it is a
// native-app peer), so that overload never enters the type program here — `Parameters<Fetch>`
// always includes `URL`, and a call-site URL assertion would pass vacuously. The explicit signature
// stays in src as consumer-facing defence; it cannot be regression-pinned in-repo.
