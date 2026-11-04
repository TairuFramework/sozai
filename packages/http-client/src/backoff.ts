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

export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000
    return Number.isFinite(delay) ? delay : undefined
  }
  // Require a weekday prefix: Date.parse also accepts negative and fractional numbers.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(value)) return undefined
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}
