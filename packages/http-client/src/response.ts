import { raceSignal } from '@sozai/async'

import { HTTPClientError } from './errors.js'
import type { HTTPResponse } from './types.js'

export async function readBody(params: {
  response: Response
  maxBytes: number
  signal?: AbortSignal
}): Promise<Uint8Array> {
  const { response, maxBytes, signal } = params
  if (signal?.aborted) throw signal.reason
  const tooLarge = () => {
    return new HTTPClientError({
      code: 'RESPONSE_TOO_LARGE',
      sent: true,
      status: response.status,
    })
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  if (response.body == null) {
    const buffer = response.arrayBuffer()
    const bytes = new Uint8Array(await (signal ? raceSignal(buffer, signal) : buffer))
    if (bytes.byteLength > maxBytes) throw tooLarge()
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let length = 0
  try {
    while (true) {
      const read = reader.read()
      const { done, value } = await (signal ? raceSignal(read, signal) : read)
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel().catch(() => {})
        throw tooLarge()
      }
      chunks.push(value)
    }
  } catch (cause) {
    if (signal?.aborted) void reader.cancel().catch(() => {})
    throw cause
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export function createHTTPResponse(params: {
  status: number
  statusText: string
  headers: Headers
  url: string
  bytes: Uint8Array
}): HTTPResponse {
  const { status, statusText, headers, url, bytes } = params
  const text = () => new TextDecoder().decode(bytes)
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    headers,
    url,
    bytes: () => bytes,
    text,
    json: <T>() => JSON.parse(text()) as T,
  }
}
