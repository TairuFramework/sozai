import type { Fetch } from '@sozai/runtime'

export function createFakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): Fetch & { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetch: Fetch = async (url, init = {}) => {
    if (typeof url !== 'string') throw new TypeError('Expected a string URL')
    calls.push({ url, init })
    return handler(url, init)
  }
  return Object.assign(fetch, { calls })
}

export function recordingSleep(): ((ms: number, signal?: AbortSignal) => Promise<void>) & {
  delays: Array<number>
} {
  const delays: Array<number> = []
  return Object.assign(
    async (ms: number, _signal?: AbortSignal) => {
      delays.push(ms)
    },
    { delays },
  )
}
