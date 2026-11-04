import { createRuntime } from '@sozai/runtime'

import { noAuth } from './auth.js'
import { HTTPClientError } from './errors.js'
import { checkTarget, resolvePolicy, toURL } from './policy.js'
import { createHTTPResponse, readBody } from './response.js'
import type { HTTPClient, HTTPClientParams, HTTPRequest, HTTPResponse } from './types.js'

export function createHTTPClient(params: HTTPClientParams): HTTPClient {
  const policy = resolvePolicy(params.policy)
  const fetch = params.fetch ?? createRuntime().fetch
  const auth = params.auth ?? noAuth
  const resolveHost = params.resolveHost

  async function sendHop(params: {
    url: URL
    method: string
    headers: Record<string, string>
    body?: string | Uint8Array
    signal: AbortSignal
  }): Promise<Response> {
    const { method, body, signal } = params
    const url = new URL(params.url.href)
    await checkTarget({ url, policy, resolveHost, sent: false })
    const headers = new Headers(params.headers)
    await auth({ url, headers })
    try {
      return await fetch(url.href, {
        method,
        headers: Object.fromEntries(headers),
        body: body as BodyInit | undefined,
        signal,
        redirect: 'manual',
      })
    } catch (cause) {
      // biome-ignore lint/style/useErrorCause: HTTPClientError takes cause in its single params object.
      throw new HTTPClientError({ code: 'NETWORK', sent: true, cause })
    }
  }

  async function runAttempt(params: {
    url: URL
    method: string
    headers: Record<string, string>
    body?: string | Uint8Array
    signal: AbortSignal
  }): Promise<HTTPResponse> {
    const response = await sendHop(params)
    const bytes = await readBody({ response, maxBytes: policy.maxResponseBytes })
    return createHTTPResponse({
      status: response.status,
      statusText: response.statusText ?? '',
      headers: response.headers,
      url: params.url.href,
      bytes,
    })
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
    return runAttempt({
      url: toURL(request.url),
      method: (request.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(headers),
      body,
      signal: request.signal ?? new AbortController().signal,
    })
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
        })
      }
      return response.json<T>()
    },
  }
}
