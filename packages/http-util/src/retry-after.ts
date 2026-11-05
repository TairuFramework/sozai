/** A `Retry-After` header value (delay-seconds or an HTTP date) as a delay in milliseconds. */
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
