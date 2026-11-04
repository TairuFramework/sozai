import type { RateLimit } from './types.js'

export type RateLimiter = {
  acquire(host: string, signal?: AbortSignal): Promise<void>
}

export function createRateLimiter(params: {
  rateLimit: RateLimit
  now: () => number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}): RateLimiter {
  const { requests, perMS } = params.rateLimit
  const rate = requests / perMS
  const buckets = new Map<string, { tokens: number; updated: number }>()

  return {
    async acquire(host, signal) {
      if (signal?.aborted) throw signal.reason
      const now = params.now()
      let bucket = buckets.get(host)
      if (bucket === undefined) {
        bucket = { tokens: requests, updated: now }
        buckets.set(host, bucket)
      }
      bucket.tokens = Math.min(requests, bucket.tokens + (now - bucket.updated) * rate) - 1
      bucket.updated = now
      const delayMS = Math.ceil(-bucket.tokens / rate)
      if (delayMS <= 0) return
      try {
        // Reserve synchronously before concurrent callers start their sleeps.
        await Promise.resolve()
        if (signal?.aborted) throw signal.reason
        await params.sleep(delayMS, signal)
        if (signal?.aborted) throw signal.reason
      } catch (cause) {
        bucket.tokens = Math.min(requests, bucket.tokens + 1)
        throw cause
      }
    },
  }
}
