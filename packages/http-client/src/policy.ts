import { raceSignal } from '@sozai/async'
import { isIPLiteral, isLoopbackHost, isPublicAddress, normalizeHostname } from '@sozai/http-util'

import { HTTPClientError } from './errors.js'
import type { HTTPRetryPolicy, RateLimit, RequestPolicy, ResolveHost } from './types.js'

export type ResolvedPolicy = {
  origins: Set<string>
  timeoutMS: number
  maxResponseBytes: number
  maxRedirects: number
  retry: HTTPRetryPolicy
  rateLimit?: RateLimit
  allowInsecureLoopback: boolean
}

function isExemptLoopback(hostname: string, allowInsecureLoopback: boolean): boolean {
  return allowInsecureLoopback && isLoopbackHost(hostname)
}

export function resolvePolicy(policy: RequestPolicy): ResolvedPolicy {
  const timeoutMS = policy.timeoutMS ?? 15_000
  const maxResponseBytes = policy.maxResponseBytes ?? 5 * 1024 * 1024
  const maxRedirects = policy.maxRedirects ?? 3
  const retry = policy.retry ?? { attempts: 3, baseDelayMS: 250, maxDelayMS: 10_000 }
  const rateLimit = policy.rateLimit
  const allowInsecureLoopback = policy.allowInsecureLoopback ?? false

  if (
    !Number.isFinite(timeoutMS) ||
    timeoutMS <= 0 ||
    !Number.isFinite(maxResponseBytes) ||
    maxResponseBytes < 0 ||
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 ||
    !Number.isInteger(retry.attempts) ||
    retry.attempts <= 0 ||
    !Number.isFinite(retry.baseDelayMS) ||
    retry.baseDelayMS < 0 ||
    !Number.isFinite(retry.maxDelayMS) ||
    retry.maxDelayMS < retry.baseDelayMS ||
    (rateLimit !== undefined &&
      (!Number.isInteger(rateLimit.requests) ||
        rateLimit.requests <= 0 ||
        !Number.isFinite(rateLimit.perMS) ||
        rateLimit.perMS <= 0))
  ) {
    throw new TypeError('Invalid HTTP request policy limits')
  }

  if (policy.origins.length === 0) throw new TypeError('At least one origin is required')
  const origins = new Set<string>()
  for (const origin of policy.origins) {
    const url = new URL(origin)
    const exempt = isExemptLoopback(normalizeHostname(url), allowInsecureLoopback)
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && exempt)) ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.href.includes('?') ||
      url.href.includes('#')
    ) {
      throw new TypeError('Invalid HTTP request policy origin')
    }
    origins.add(url.origin)
  }

  return {
    origins,
    timeoutMS,
    maxResponseBytes,
    maxRedirects,
    retry: { ...retry },
    ...(rateLimit === undefined ? {} : { rateLimit: { ...rateLimit } }),
    allowInsecureLoopback,
  }
}

export function toURL(input: string | URL): URL {
  try {
    return new URL(input)
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: HTTPClientError takes cause in its single params object.
    throw new HTTPClientError({ code: 'INSECURE_URL', sent: false, cause })
  }
}

export async function checkTarget(params: {
  url: URL
  policy: ResolvedPolicy
  resolveHost?: ResolveHost
  sent: boolean
  signal?: AbortSignal
}): Promise<void> {
  const { url, policy, resolveHost, sent, signal } = params
  const malformedHostname = url.hostname.includes('..')
  const hostname = normalizeHostname(url)
  const exempt = !malformedHostname && isExemptLoopback(hostname, policy.allowInsecureLoopback)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && exempt)) {
    throw new HTTPClientError({ code: 'INSECURE_URL', sent })
  }
  if (url.username !== '' || url.password !== '') {
    throw new HTTPClientError({ code: 'INSECURE_URL', sent })
  }
  if (!policy.origins.has(url.origin)) {
    throw new HTTPClientError({ code: 'ORIGIN_REFUSED', sent })
  }
  if (malformedHostname) {
    throw new HTTPClientError({ code: 'ADDRESS_REFUSED', sent })
  }
  if (exempt) return

  if (isIPLiteral(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new HTTPClientError({ code: 'ADDRESS_REFUSED', sent })
    }
    return
  }
  // Numeric hosts must not escape literal validation through DNS resolution.
  if (
    hostname === '' ||
    /^[0-9.]+$/.test(hostname) ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost')
  ) {
    throw new HTTPClientError({ code: 'ADDRESS_REFUSED', sent })
  }
  if (resolveHost === undefined) return

  let addresses: Array<string>
  try {
    const lookup = resolveHost(hostname, { signal })
    addresses = await (signal ? raceSignal(lookup, signal) : lookup)
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: HTTPClientError takes cause in its single params object.
    throw new HTTPClientError({ code: 'NETWORK', sent: false, cause })
  }
  if (addresses.length === 0) {
    throw new HTTPClientError({ code: 'NETWORK', sent: false })
  }
  if (addresses.some((address) => !isPublicAddress(address))) {
    throw new HTTPClientError({ code: 'ADDRESS_REFUSED', sent })
  }
}
