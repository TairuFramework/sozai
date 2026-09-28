/** Format an in-range epoch time as canonical UTC. */
export function toTimestamp(ms: number): string {
  const timestamp = new Date(ms).toISOString()

  if (!isCanonicalTimestamp(timestamp)) {
    throw new RangeError('Timestamp is outside canonical UTC range')
  }

  return timestamp
}

/** Check the canonical millisecond UTC timestamp form. */
export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false
  }

  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}
