import type { HTTPRetryPolicy } from './types.js'

export const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])

export function getBackoffDelay(params: {
  retry: HTTPRetryPolicy
  retryIndex: number
  random: () => number
}): number {
  const { retry, retryIndex, random } = params
  return Math.floor(
    random() * Math.min(retry.maxDelayMS, retry.baseDelayMS * 2 ** (retryIndex - 1)),
  )
}
