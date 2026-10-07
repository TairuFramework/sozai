import getPort from 'get-port'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createServer, definePlugin, type HTTPServer } from '../src/index.js'

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

  test('setup failure runs the failing plugin hooks and rejects', async () => {
    const spy = vi.fn()
    const failing = definePlugin({
      name: 'test:failing',
      setup(ctx) {
        ctx.onClose(spy)
        throw new Error('nope')
      },
    })
    await expect(createServer({ plugins: [failing] })).rejects.toThrow('nope')
    expect(spy).toHaveBeenCalledOnce()
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
