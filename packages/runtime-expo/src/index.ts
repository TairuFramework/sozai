import type { GetRandomValues, Runtime } from '@sozai/runtime'
import { getRandomValues, randomUUID } from 'expo-crypto'

/**
 * Delegates at call time (not bind time), so fetch polyfills installed after import apply.
 *
 * Signature is spelled out rather than derived from `Fetch`: React Native's global fetch
 * declaration overloads the DOM one here, and `Parameters<Fetch>` would resolve to RN's
 * narrower overload, dropping `URL` input support.
 */
function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init)
}

export const expoRuntime: Runtime = {
  fetch: defaultFetch,
  getRandomID: randomUUID,
  getRandomValues: getRandomValues as GetRandomValues,
}

export function createRuntime(overrides?: Partial<Runtime>): Runtime {
  return {
    fetch: overrides?.fetch ?? expoRuntime.fetch,
    getRandomID: overrides?.getRandomID ?? expoRuntime.getRandomID,
    getRandomValues: overrides?.getRandomValues ?? expoRuntime.getRandomValues,
  }
}

export function polyfillCrypto(override = false) {
  if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = {} as Crypto
  }
  if (override || typeof globalThis.crypto.getRandomValues !== 'function') {
    globalThis.crypto.getRandomValues = getRandomValues as Crypto['getRandomValues']
  }
  if (override || typeof globalThis.crypto.randomUUID !== 'function') {
    globalThis.crypto.randomUUID = randomUUID as Crypto['randomUUID']
  }
}

export function polyfill(override = false) {
  polyfillCrypto(override)
}
