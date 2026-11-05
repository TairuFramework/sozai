import { sleep as defaultSleep, raceSignal } from '@sozai/async'
import { parseRetryAfter } from '@sozai/http-util'
import { createRuntime } from '@sozai/runtime'

import { noAuth } from './auth.js'
import { getBackoffDelay, RETRYABLE_STATUSES } from './backoff.js'
import { HTTPClientError } from './errors.js'
import { checkTarget, resolvePolicy, toURL } from './policy.js'
import { createRateLimiter } from './rate-limit.js'
import { createHTTPResponse, readBody } from './response.js'
import { linkSignal } from './signal.js'
import type { HTTPClient, HTTPClientParams, HTTPRequest, HTTPResponse } from './types.js'

export function createHTTPClient(params: HTTPClientParams): HTTPClient {
  const policy = resolvePolicy(params.policy)
  const fetch = params.fetch ?? createRuntime().fetch
  const auth = params.auth ?? noAuth
  const resolveHost = params.resolveHost
  const sleep = params.sleep ?? defaultSleep
  const rateLimiter = policy.rateLimit
    ? createRateLimiter({ rateLimit: policy.rateLimit, now: Date.now, sleep })
    : undefined

  async function sendHop(params: {
    url: URL
    method: string
    headers: Record<string, string>
    body?: string | Uint8Array
    signal?: AbortSignal
    startTimer(): AbortSignal
    sent: boolean
    failure(cause: unknown): HTTPClientError
    markSent(): void
  }): Promise<{ response: Response; sentURL: string } | HTTPClientError> {
    const { method, body } = params
    let signal = params.signal
    params.url.hash = ''
    const url = new URL(params.url.href)
    if (signal?.aborted) return params.failure(signal.reason)
    try {
      await rateLimiter?.acquire(url.host, signal)
    } catch (cause) {
      return params.failure(signal?.aborted ? signal.reason : cause)
    }
    signal = params.startTimer()
    if (signal.aborted) return params.failure(signal.reason)
    try {
      await checkTarget({ url, policy, resolveHost, sent: params.sent, signal })
    } catch (cause) {
      if (signal.aborted) return params.failure(signal.reason)
      if (cause instanceof HTTPClientError && cause.code === 'NETWORK') {
        return params.failure(cause.cause)
      }
      throw cause
    }
    if (signal.aborted) return params.failure(signal.reason)
    const headers = new Headers(params.headers)
    try {
      await raceSignal(Promise.resolve(auth({ url, headers })), signal)
    } catch (cause) {
      if (signal.aborted) return params.failure(signal.reason)
      throw cause
    }
    if (signal.aborted) return params.failure(signal.reason)
    params.markSent()
    try {
      const sentURL = url.href
      const response = await fetch(sentURL, {
        method,
        headers: Object.fromEntries(headers),
        body: body as BodyInit | undefined,
        signal,
        redirect: 'manual',
      })
      return { response, sentURL }
    } catch (cause) {
      return params.failure(signal.aborted ? signal.reason : cause)
    }
  }

  async function runAttempt(params: {
    url: URL
    method: string
    headers: Record<string, string>
    body?: string | Uint8Array
    signal?: AbortSignal
    sent: boolean
    markSent(): void
    retryIndex?: number
  }): Promise<HTTPResponse | HTTPClientError | { retryDelayMS: number }> {
    let linked: ReturnType<typeof linkSignal> | undefined
    const startTimer = () => {
      linked ??= linkSignal({ parent: params.signal, timeoutMS: policy.timeoutMS })
      return linked.signal
    }
    let sent = params.sent
    const failure = (cause: unknown) => {
      return new HTTPClientError({
        code: linked?.timedOut()
          ? 'TIMEOUT'
          : (linked?.signal ?? params.signal)?.aborted
            ? 'ABORTED'
            : 'NETWORK',
        sent,
        cause,
      })
    }
    try {
      let { url, method, body } = params
      const headers = new Headers(params.headers)
      let redirects = 0
      while (true) {
        const hop = await sendHop({
          url,
          method,
          body,
          headers: Object.fromEntries(headers),
          signal: linked?.signal ?? params.signal,
          startTimer,
          sent,
          failure,
          markSent: () => {
            sent = true
            params.markSent()
          },
        })
        if (hop instanceof HTTPClientError) return hop
        const { response, sentURL } = hop
        if (response.type === 'opaqueredirect' || response.status === 0) {
          return new HTTPClientError({ code: 'NETWORK', sent: true })
        }
        const finalURL = response.url && response.url !== sentURL ? response.url : url.href
        if (finalURL !== url.href && !policy.origins.has(new URL(finalURL).origin)) {
          await response.body?.cancel().catch(() => {})
          throw new HTTPClientError({ code: 'ORIGIN_REFUSED', sent: true })
        }
        const location = response.headers.get('location')
        if ([301, 302, 303, 307, 308].includes(response.status) && location !== null) {
          await response.body?.cancel().catch(() => {})
          if (redirects >= policy.maxRedirects) {
            throw new HTTPClientError({ code: 'TOO_MANY_REDIRECTS', sent: true })
          }
          if (
            (response.status === 303 && method !== 'HEAD') ||
            ((response.status === 301 || response.status === 302) && method === 'POST')
          ) {
            method = 'GET'
            body = undefined
            headers.delete('content-type')
            headers.delete('content-length')
          }
          let nextURL: URL
          try {
            nextURL = new URL(location, url)
          } catch (cause) {
            return new HTTPClientError({ code: 'NETWORK', sent: true, cause })
          }
          if (nextURL.origin !== url.origin) {
            headers.delete('authorization')
            headers.delete('cookie')
            headers.delete('proxy-authorization')
          }
          url = nextURL
          redirects++
          continue
        }
        if (params.retryIndex !== undefined && RETRYABLE_STATUSES.has(response.status)) {
          const retryAfterMS = parseRetryAfter(response.headers.get('retry-after'), Date.now())
          if (retryAfterMS === undefined || retryAfterMS <= policy.retry.maxDelayMS) {
            await response.body?.cancel().catch(() => {})
            return {
              retryDelayMS:
                retryAfterMS ??
                getBackoffDelay({
                  retry: policy.retry,
                  retryIndex: params.retryIndex,
                  random: Math.random,
                }),
            }
          }
        }
        let bytes: Uint8Array
        try {
          bytes = await readBody({
            response,
            maxBytes: policy.maxResponseBytes,
            signal: startTimer(),
          })
        } catch (cause) {
          if (cause instanceof HTTPClientError) throw cause
          return failure(cause)
        }
        return createHTTPResponse({
          status: response.status,
          statusText: response.statusText ?? '',
          headers: response.headers,
          url: finalURL,
          bytes,
        })
      }
    } finally {
      linked?.dispose()
    }
  }

  async function request(request: HTTPRequest): Promise<HTTPResponse> {
    if (request.json !== undefined && request.body !== undefined) {
      throw new TypeError('json and body are mutually exclusive')
    }
    const headers = new Headers(request.headers)
    let body = request.body
    if (request.json !== undefined) {
      body = JSON.stringify(request.json)
      if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    }
    const url = toURL(request.url)
    const method = (request.method ?? 'GET').toUpperCase()
    const idempotent = request.idempotent ?? (method === 'GET' || method === 'HEAD')
    let sent = false
    for (let attempt = 1; ; attempt++) {
      const canRetry = idempotent && attempt < policy.retry.attempts
      const result = await runAttempt({
        url,
        method,
        headers: Object.fromEntries(headers),
        body,
        signal: request.signal,
        sent,
        markSent: () => {
          sent = true
        },
        retryIndex: canRetry ? attempt : undefined,
      })
      let delayMS: number
      if (result instanceof HTTPClientError) {
        if (!canRetry || (result.code !== 'NETWORK' && result.code !== 'TIMEOUT')) throw result
        delayMS = getBackoffDelay({ retry: policy.retry, retryIndex: attempt, random: Math.random })
      } else if ('retryDelayMS' in result) {
        delayMS = result.retryDelayMS
      } else {
        return result
      }
      try {
        await sleep(delayMS, request.signal)
      } catch (cause) {
        if (!request.signal?.aborted) throw cause
        // biome-ignore lint/style/useErrorCause: HTTPClientError takes cause in its single params object.
        throw new HTTPClientError({ code: 'ABORTED', sent, cause: request.signal.reason })
      }
    }
  }

  return {
    request,
    async json<T>(input: HTTPRequest): Promise<T> {
      const headers = new Headers(input.headers)
      if (!headers.has('accept')) headers.set('accept', 'application/json')
      const response = await request({ ...input, headers: Object.fromEntries(headers) })
      if (!response.ok) {
        throw new HTTPClientError({
          code: 'STATUS',
          sent: true,
          status: response.status,
          response,
          retryAfterMS: parseRetryAfter(response.headers.get('retry-after'), Date.now()),
        })
      }
      return response.json<T>()
    },
  }
}
