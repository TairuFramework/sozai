import { Hono } from 'hono'
import { describe, expect, onTestFinished, test } from 'vitest'

import { createServer, definePlugin } from '../src/index.js'
import { isLoopbackAddress, isSecureTransport, transportInfo } from '../src/transport.js'

describe('isLoopbackAddress', () => {
  test.each([
    '127.0.0.1',
    '127.255.255.255',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'localhost',
  ])('recognizes %s as loopback', (address) => {
    expect(isLoopbackAddress(address)).toBe(true)
  })

  test.each(['127.0.0.256', '128.0.0.1', '::2', '10.0.0.1', '', null])(
    'rejects %s as loopback',
    (address) => {
      expect(isLoopbackAddress(address)).toBe(false)
    },
  )
})

describe('isSecureTransport', () => {
  test('rejects missing transport information', () => {
    expect(isSecureTransport(undefined)).toBe(false)
  })

  test('accepts encrypted transport with non-loopback addresses', () => {
    expect(
      isSecureTransport({ secure: true, localAddress: '10.0.0.1', remoteAddress: '10.0.0.2' }),
    ).toBe(true)
  })

  test('accepts an unencrypted loopback pair', () => {
    expect(
      isSecureTransport({ secure: false, localAddress: '127.0.0.1', remoteAddress: '::1' }),
    ).toBe(true)
  })

  test.each([
    { secure: false, localAddress: '127.0.0.1', remoteAddress: '10.0.0.2' },
    { secure: false, localAddress: '10.0.0.1', remoteAddress: '::1' },
    { secure: false, localAddress: null, remoteAddress: '::1' },
    { secure: false, localAddress: '127.0.0.1', remoteAddress: null },
  ])('rejects a single loopback side: %j', (info) => {
    expect(isSecureTransport(info)).toBe(false)
  })
})

describe('transportInfo', () => {
  test('returns undefined for a request without a socket', async () => {
    const app = new Hono()
    app.get('/', (c) => {
      expect(transportInfo(c)).toBeUndefined()
      return c.text('ok')
    })
    expect(
      (
        await app.request('https://localhost/', {
          headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '127.0.0.1' },
        })
      ).status,
    ).toBe(200)
  })

  test('reads socket transport facts from a real HTTP server', async () => {
    const server = await createServer({
      port: 0,
      hostname: '127.0.0.1',
      plugins: [
        definePlugin({
          name: 'test:transport',
          setup(ctx) {
            ctx.route('get', '/transport', (c) => c.json(transportInfo(c)))
          },
        }),
      ],
    })
    onTestFinished(() => server.dispose())
    await server.listen()
    const response = await fetch(`${server.url}/transport`, {
      headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '10.0.0.1' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      secure: false,
      localAddress: '127.0.0.1',
      remoteAddress: '127.0.0.1',
    })
  })
})
