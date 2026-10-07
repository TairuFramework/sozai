import getPort from 'get-port'
import type { SSEStreamingApi } from 'hono/streaming'
import { streamSSE } from 'hono/streaming'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  type CreateServerParams,
  createServer,
  definePlugin,
  type HTTPServer,
} from '../src/index.js'

const servers: Array<HTTPServer> = []

async function listening(params: CreateServerParams): Promise<HTTPServer> {
  const server = await createServer({ port: await getPort(), ...params })
  servers.push(server)
  await server.listen()
  return server
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()))
})

function closeOrder(order: Array<string>, hang = false) {
  const db = definePlugin({
    name: 'db',
    setup(ctx) {
      ctx.onClose(() => {
        order.push('db')
      })
    },
  })
  const app = definePlugin({
    name: 'app',
    dependsOn: ['db'],
    setup(ctx) {
      ctx.onClose(() => {
        order.push('app')
        return hang ? new Promise<void>(() => {}) : undefined
      })
    },
  })
  return [app, db]
}

describe('graceful shutdown', () => {
  test('onShutdown delivers a final stream event before sockets close', async () => {
    const opened = Promise.withResolvers<void>()
    let active: { stream: SSEStreamingApi; done: () => void } | undefined
    const server = await listening({
      plugins: [
        definePlugin({
          name: 'test:events',
          setup(ctx) {
            ctx.route('get', '/events', (c) => {
              return streamSSE(c, async (stream) => {
                const done = Promise.withResolvers<void>()
                active = { stream, done: done.resolve }
                await stream.writeSSE({ data: 'hello' })
                opened.resolve()
                await done.promise
              })
            })
            ctx.onShutdown(async () => {
              await active?.stream.writeSSE({ data: 'bye' })
              active?.done()
            })
          },
        }),
      ],
    })

    const res = await fetch(`${server.url}/events`)
    await opened.promise
    const text = res.text()
    await server.dispose()
    expect((await text).trimEnd()).toMatch(/data: hello\n\ndata: bye$/)
    expect(server.shutdownReport).toEqual({
      forced: false,
      hooks: [{ plugin: 'test:events', phase: 'shutdown', outcome: 'completed' }],
    })
  })

  test('drain waits for in-flight responses', async () => {
    const started = Promise.withResolvers<void>()
    let handlerFinished = false
    const server = await listening({
      plugins: [
        definePlugin({
          name: 'test:slow',
          setup(ctx) {
            ctx.route('get', '/slow', async (c) => {
              started.resolve()
              await new Promise((resolve) => setTimeout(resolve, 100))
              handlerFinished = true
              return c.text('done')
            })
          },
        }),
      ],
    })

    const pending = fetch(`${server.url}/slow`)
    await started.promise
    await server.dispose()
    expect(handlerFinished).toBe(true)
    const res = await pending
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('done')
    expect(server.shutdownReport?.forced).toBe(false)
  })

  test('drain deadline forces sockets closed', async () => {
    const opened = Promise.withResolvers<void>()
    const server = await listening({
      graceMs: 50,
      plugins: [
        definePlugin({
          name: 'test:endless',
          setup(ctx) {
            ctx.route('get', '/endless', (c) => {
              return streamSSE(c, async (stream) => {
                await stream.writeSSE({ data: 'tick' })
                opened.resolve()
                await new Promise(() => {})
              })
            })
          },
        }),
      ],
    })

    const res = await fetch(`${server.url}/endless`)
    await opened.promise
    const body = res.text().catch(() => '')
    const start = performance.now()
    await server.dispose()
    expect(performance.now() - start).toBeLessThan(1000)
    expect(server.shutdownReport?.forced).toBe(true)
    await body
  })

  test('a route that throws after streaming started is counted until close', async () => {
    const opened = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const graceMs = 1000
    const server = await listening({
      graceMs,
      plugins: [
        definePlugin({
          name: 'test:throwing',
          setup(ctx) {
            ctx.route('get', '/throws', (c) => {
              // With an onError callback streamSSE reports the error to the client
              // instead of logging it to the console.
              return streamSSE(
                c,
                async (stream) => {
                  await stream.writeSSE({ data: 'one' })
                  opened.resolve()
                  await gate.promise
                  throw new Error('stream failed')
                },
                async () => {},
              )
            })
          },
        }),
      ],
    })

    const res = await fetch(`${server.url}/throws`)
    await opened.promise
    const body = res.text().catch(() => '')
    const start = performance.now()
    const disposed = server.dispose()
    // The open stream must hold disposal back until the route finishes.
    const settled = await Promise.race([
      disposed.then(() => 'disposed'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
    ])
    expect(settled).toBe('pending')
    gate.resolve()
    await disposed
    expect(performance.now() - start).toBeLessThan(graceMs)
    expect(server.shutdownReport).toEqual({ forced: false, hooks: [] })
    expect(await body).toContain('data: one')
  })

  test('close hooks run in reverse dependency order', async () => {
    const order: Array<string> = []
    const server = await createServer({ plugins: closeOrder(order) })
    await server.dispose()
    expect(order).toEqual(['app', 'db'])
  })

  test('a timed-out close hook is reported and later hooks still run', async () => {
    const order: Array<string> = []
    const server = await createServer({ closeHookTimeoutMs: 20, plugins: closeOrder(order, true) })
    await server.dispose()
    expect(order).toEqual(['app', 'db'])
    expect(server.shutdownReport?.hooks).toEqual([
      { plugin: 'app', phase: 'close', outcome: 'timed-out' },
      { plugin: 'db', phase: 'close', outcome: 'completed' },
    ])
  })

  test('a hook rejecting after its timeout is logged without an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const lateError = new Error('late failure')
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        with: () => logger,
      }
      const server = await createServer({
        logger: logger as unknown as CreateServerParams['logger'],
        plugins: [
          definePlugin({
            name: 'test:late',
            setup(ctx) {
              ctx.onClose(
                () => new Promise<void>((_, reject) => setTimeout(() => reject(lateError), 60)),
                { timeoutMs: 10 },
              )
            },
          }),
        ],
      })
      await server.dispose()
      expect(server.shutdownReport?.hooks).toEqual([
        { plugin: 'test:late', phase: 'close', outcome: 'timed-out' },
      ])
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(logger.error).toHaveBeenCalledWith('Shutdown hook failed after timing out', {
        plugin: 'test:late',
        phase: 'close',
        error: lateError,
      })
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  test('a failing hook is reported and later hooks still run', async () => {
    const server = await createServer({
      plugins: [
        definePlugin({
          name: 'test:failing',
          setup(ctx) {
            ctx.onShutdown(() => {
              throw new Error('shutdown failed')
            })
            ctx.onClose(() => Promise.reject(new Error('close failed')))
            ctx.onClose(() => {})
          },
        }),
      ],
    })
    await server.dispose()
    expect(server.shutdownReport?.hooks).toEqual([
      { plugin: 'test:failing', phase: 'shutdown', outcome: 'failed' },
      { plugin: 'test:failing', phase: 'close', outcome: 'completed' },
      { plugin: 'test:failing', phase: 'close', outcome: 'failed' },
    ])
  })

  test('a close hook can extend its own budget', async () => {
    const server = await createServer({
      closeHookTimeoutMs: 20,
      plugins: [
        definePlugin({
          name: 'test:slow-close',
          setup(ctx) {
            ctx.onClose(() => new Promise<void>((resolve) => setTimeout(resolve, 50)), {
              timeoutMs: 200,
            })
          },
        }),
      ],
    })
    await server.dispose()
    expect(server.shutdownReport?.hooks).toEqual([
      { plugin: 'test:slow-close', phase: 'close', outcome: 'completed' },
    ])
  })

  test('handleSignals disposes on SIGTERM', async () => {
    const server = await createServer({})
    const before = process.listenerCount('SIGTERM')
    const beforeInt = process.listenerCount('SIGINT')
    const unsubscribe = server.handleSignals()
    expect(process.listenerCount('SIGTERM')).toBe(before + 1)
    expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1)

    process.emit('SIGTERM')
    await server.disposed
    expect(process.listenerCount('SIGTERM')).toBe(before)
    expect(process.listenerCount('SIGINT')).toBe(beforeInt)
    unsubscribe()
    expect(process.listenerCount('SIGTERM')).toBe(before)
    expect(process.listenerCount('SIGINT')).toBe(beforeInt)
  })
})
