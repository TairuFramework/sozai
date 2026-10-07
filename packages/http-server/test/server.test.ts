import { once } from 'node:events'
import type { Server } from 'node:http'
import { connect } from 'node:net'
import { type LogRecord, reset, setup } from '@sozai/log'
import getPort from 'get-port'
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'

import { createServer, definePlugin, type HTTPServer } from '../src/index.js'

const nodeServers = vi.hoisted(() => [] as Array<Server>)

vi.mock('@hono/node-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hono/node-server')>()
  return {
    ...actual,
    createAdaptorServer: (...args: Parameters<typeof actual.createAdaptorServer>) => {
      const server = actual.createAdaptorServer(...args)
      nodeServers.push(server as Server)
      return server
    },
  }
})

function captureLogs(): Array<LogRecord> {
  const records: Array<LogRecord> = []
  setup({
    sinks: {
      memory: (record: LogRecord) => {
        records.push(record)
      },
    },
    loggers: [
      { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: [] },
      { category: ['sozai'], lowestLevel: 'debug', sinks: ['memory'] },
    ],
  })
  onTestFinished(() => reset())
  return records
}

function findRecord(records: Array<LogRecord>, message: string): LogRecord | undefined {
  return records.find((record) => record.rawMessage === message)
}

const servers: Array<HTTPServer> = []

async function create(params: Parameters<typeof createServer>[0]): Promise<HTTPServer> {
  const server = await createServer(params)
  servers.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()))
})

const hello = definePlugin({
  name: 'test:hello',
  setup(ctx) {
    ctx.route('get', '/hello', (c) => c.text('hi'))
  },
})

describe('HTTPServer', () => {
  test('listens on the requested port and serves plugin routes', async () => {
    const port = await getPort()
    const server = await create({ port, plugins: [hello] })
    await server.listen()
    expect(server.url).toBe(`http://localhost:${port}`)

    const res = await fetch(`${server.url}/hello`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hi')
  })

  test('brackets IPv6 hosts in url', async () => {
    const server = await create({ port: await getPort(), hostname: '::1', plugins: [hello] })
    await server.listen()
    expect(server.url.startsWith('http://[::1]:')).toBe(true)
    expect(await (await fetch(`${server.url}/hello`)).text()).toBe('hi')
  })

  test('url throws before listen', async () => {
    const server = await create({})
    expect(() => server.url).toThrow('Server is not listening')
  })

  test('bind failure disposes and rejects', async () => {
    const port = await getPort()
    const first = await create({ port })
    await first.listen()

    const spy = vi.fn()
    const second = await create({
      port,
      plugins: [
        definePlugin({
          name: 'test:closer',
          setup(ctx) {
            ctx.onClose(spy)
          },
        }),
      ],
    })
    await expect(second.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(spy).toHaveBeenCalledOnce()
    await expect(second.listen()).rejects.toThrow('Server is disposed')
  })

  test('dispose before the socket binds rejects listen and leaves the port free', async () => {
    const port = await getPort()
    const server = await create({ port })
    const listened = server.listen()
    const disposed = server.dispose()
    const outcome = await Promise.race([
      listened.then(
        () => 'listening',
        (error: Error) => error.message,
      ),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ])
    expect(outcome).toBe('Server is disposed')
    await disposed

    const next = await create({ port })
    await next.listen()
    expect(next.url).toBe(`http://localhost:${port}`)
  })

  test('setup failure runs the failing plugin hooks and rejects naming the plugin', async () => {
    const records = captureLogs()
    const spy = vi.fn()
    const cause = new Error('nope')
    const failing = definePlugin({
      name: 'test:failing',
      setup(ctx) {
        ctx.onClose(spy)
        throw cause
      },
    })
    const error = await createServer({ plugins: [failing] }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Plugin "test:failing" setup failed')
    expect((error as Error).cause).toBe(cause)
    expect(spy).toHaveBeenCalledOnce()
    expect(findRecord(records, 'Plugin setup failed')?.properties).toMatchObject({
      plugin: 'test:failing',
      error: cause,
    })
  })

  test('plugin loggers tag records with the plugin name', async () => {
    const records = captureLogs()
    await create({
      plugins: [
        definePlugin({
          name: 'test:logging',
          setup(ctx) {
            ctx.logger.info('hello from plugin')
          },
        }),
      ],
    })
    expect(findRecord(records, 'hello from plugin')?.properties).toMatchObject({
      plugin: 'test:logging',
    })
  })

  test('server errors after listen are logged, not thrown', async () => {
    const records = captureLogs()
    const server = await create({ port: await getPort() })
    await server.listen()
    const nodeServer = nodeServers.at(-1)
    const error = new Error('EMFILE')
    expect(() => nodeServer?.emit('error', error)).not.toThrow()
    expect(findRecord(records, 'HTTP server error')?.properties).toMatchObject({ error })
  })

  test('a concurrent listen call rejects without binding a second server', async () => {
    const server = await create({ port: { port: await getPort() } })
    const before = nodeServers.length
    const first = server.listen()
    const second = server.listen()
    await expect(second).rejects.toThrow('Server is already listening')
    await first
    expect(nodeServers.length).toBe(before + 1)
  })

  test('shutdown closes connections holding a partial request', async () => {
    const server = await create({ port: await getPort(), hostname: '127.0.0.1' })
    await server.listen()
    const socket = connect(Number(new URL(server.url).port), '127.0.0.1')
    onTestFinished(() => {
      socket.destroy()
    })
    await once(socket, 'connect')
    socket.write('GET /hello HTTP/1.1\r\nHost: localhost\r\n')
    await new Promise((resolve) => setTimeout(resolve, 50))

    const closed = once(socket, 'close')
    await server.dispose()
    const outcome = await Promise.race([
      closed.then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('open'), 1000)),
    ])
    expect(outcome).toBe('closed')
  })

  test('an all route serves every method', async () => {
    const server = await create({
      plugins: [
        definePlugin({
          name: 'test:all',
          setup(ctx) {
            ctx.route('all', '/any', (c) => c.text(c.req.method))
          },
        }),
      ],
    })
    expect(await (await server.app.request('/any')).text()).toBe('GET')
    expect(await (await server.app.request('/any', { method: 'POST' })).text()).toBe('POST')
  })

  test('parent abort during setup waits for the running setup', async () => {
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const spyA = vi.fn()
    const setupB = vi.fn()
    const a = definePlugin({
      name: 'test:a',
      async setup(ctx) {
        started.resolve()
        await gate.promise
        ctx.onClose(spyA)
      },
    })
    const b = definePlugin({ name: 'test:b', dependsOn: ['test:a'], setup: setupB })

    const created = createServer({ plugins: [a, b], signal: controller.signal })
    await started.promise
    controller.abort(new Error('stop'))
    gate.resolve()

    await expect(created).rejects.toThrow('stop')
    expect(spyA).toHaveBeenCalledOnce()
    expect(setupB).not.toHaveBeenCalled()
  })

  test('an already aborted parent signal rejects without running setup', async () => {
    const setup = vi.fn()
    const signal = AbortSignal.abort(new Error('early'))
    await expect(
      createServer({ plugins: [definePlugin({ name: 'test:x', setup })], signal }),
    ).rejects.toThrow('early')
    expect(setup).not.toHaveBeenCalled()
  })

  test('an invalid trustProxy entry rejects', async () => {
    await expect(createServer({ trustProxy: ['nope'] })).rejects.toThrow(
      'Invalid trustProxy entry "nope"',
    )
  })

  test('dispose twice returns the same promise', async () => {
    const server = await create({})
    expect(server.dispose()).toBe(server.dispose())
    await server.disposed
  })

  test('await using disposes', async () => {
    const spy = vi.fn()
    {
      await using server = await createServer({
        plugins: [
          definePlugin({
            name: 'test:closer',
            setup(ctx) {
              ctx.onClose(spy)
            },
          }),
        ],
      })
      expect(server.signal.aborted).toBe(false)
    }
    expect(spy).toHaveBeenCalledOnce()
  })

  test('readiness reports 503 once shutdown begins', async () => {
    let status: number | undefined
    const server: HTTPServer = await create({
      plugins: [
        definePlugin({
          name: 'test:probe',
          setup(ctx) {
            ctx.onShutdown(async () => {
              status = (await server.app.request('/health/ready')).status
            })
          },
        }),
      ],
    })
    expect((await server.app.request('/health/ready')).status).toBe(200)
    await server.dispose()
    expect(status).toBe(503)
  })

  test('readiness aggregates plugin checks', async () => {
    const server = await create({
      plugins: [
        definePlugin({
          name: 'test:check',
          setup(ctx) {
            ctx.addReadinessCheck(() => false)
          },
        }),
      ],
    })
    const res = await server.app.request('/health/ready')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'unavailable', checks: { 'test:check': false } })
  })
})
