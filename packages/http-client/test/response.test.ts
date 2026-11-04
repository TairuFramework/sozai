import { expect, test, vi } from 'vitest'

import { createHTTPResponse, readBody } from '../src/response.js'

test('rejects a declared length over the cap before reading', async () => {
  const cancel = vi.fn()
  const response = new Response(new ReadableStream({ cancel }), {
    status: 201,
    headers: { 'content-length': '11' },
  })
  await expect(readBody({ response, maxBytes: 10 })).rejects.toMatchObject({
    code: 'RESPONSE_TOO_LARGE',
    sent: true,
    status: 201,
  })
  expect(cancel).toHaveBeenCalledOnce()
  expect(response.body?.locked).toBe(false)
})

test('rejects a streamed body over the cap', async () => {
  const cancel = vi.fn()
  const chunks = [new Uint8Array(6), new Uint8Array(5)]
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift()
        if (chunk !== undefined) controller.enqueue(chunk)
      },
      cancel,
    }),
  )
  await expect(readBody({ response, maxBytes: 10 })).rejects.toMatchObject({
    code: 'RESPONSE_TOO_LARGE',
    sent: true,
    status: 200,
  })
  expect(cancel).toHaveBeenCalledOnce()
  expect(response.body?.locked).toBe(false)
})

test('accepts a body of exactly the cap', async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3, 4, 5]))
        controller.close()
      },
    }),
    { headers: { 'content-length': '5' } },
  )
  expect(await readBody({ response, maxBytes: 5 })).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
})

test('buffers a response without a body stream', async () => {
  const response = {
    status: 202,
    headers: new Headers(),
    body: null,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as Response
  expect(await readBody({ response, maxBytes: 3 })).toEqual(new Uint8Array([1, 2, 3]))
  await expect(readBody({ response, maxBytes: 2 })).rejects.toMatchObject({
    code: 'RESPONSE_TOO_LARGE',
    sent: true,
    status: 202,
  })
})

test('accepts an empty body with a zero cap', async () => {
  expect(await readBody({ response: new Response(null), maxBytes: 0 })).toEqual(new Uint8Array())
})

test('decodes malformed UTF-8 non-fatally and leaves JSON parse errors unwrapped', () => {
  const response = createHTTPResponse({
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    url: 'https://api.example.com/',
    bytes: new Uint8Array([255]),
  })
  expect(response.text()).toBe('\uFFFD')
  expect(() => response.json()).toThrow(SyntaxError)
})

test.each([199, 200, 299, 300])('derives ok from status %s', (status) => {
  const response = createHTTPResponse({
    status,
    statusText: '',
    headers: new Headers(),
    url: 'https://api.example.com/',
    bytes: new Uint8Array(),
  })
  expect(response.ok).toBe(status === 200 || status === 299)
})

test('caps the real body even when content-length understates it', async () => {
  const cancel = vi.fn()
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(11))
      },
      cancel,
    }),
    { headers: { 'content-length': '1' } },
  )
  await expect(readBody({ response, maxBytes: 10 })).rejects.toMatchObject({
    code: 'RESPONSE_TOO_LARGE',
    sent: true,
    status: 200,
  })
  expect(cancel).toHaveBeenCalledOnce()
  expect(response.body?.locked).toBe(false)
})
