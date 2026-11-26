import { createServer as createNodeServer, type Server } from 'node:http'
import { afterEach, expect, test, vi } from 'vitest'

import { createServer, definePlugin, type HTTPServer } from '../src/index.js'

const racers = vi.hoisted(() => ({ enabled: false, servers: [] as Array<Server> }))

function listen(server: Server, port: number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
}

// Another process binding loopback explicitly between the get-port probe and the server bind.
// macOS lets those binds coexist with a later wildcard bind on the same port.
vi.mock('get-port', async (importOriginal) => {
  const actual = await importOriginal<typeof import('get-port')>()
  return {
    ...actual,
    default: async (...args: Parameters<typeof actual.default>) => {
      const port = await actual.default(...args)
      if (racers.enabled) {
        for (const host of ['127.0.0.1', '::1']) {
          const racer = createNodeServer((_req, res) => {
            res.writeHead(407, { 'proxy-authenticate': 'Basic' })
            res.end()
          })
          racers.servers.push(racer)
          await listen(racer, port, host)
        }
      }
      return port
    },
  }
})

const hello = definePlugin({
  name: 'test:hello',
  setup(ctx) {
    ctx.route('get', '/hello', (c) => c.text('hi'))
  },
})

const servers: Array<HTTPServer> = []
const held: Array<Server> = []

afterEach(async () => {
  racers.enabled = false
  await Promise.all(servers.splice(0).map((server) => server.dispose()))
  for (const server of [...racers.servers.splice(0), ...held.splice(0)]) {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a busy preferred port falls back to a port no racing loopback listener can share', async () => {
  const busy = createNodeServer()
  held.push(busy)
  await listen(busy, 0)
  const address = busy.address()
  if (address == null || typeof address === 'string') throw new Error('expected a TCP address')

  racers.enabled = true
  const server = await createServer({ port: { port: address.port }, plugins: [hello] })
  servers.push(server)
  await server.listen()

  const response = await fetch(new URL('/hello', server.url))
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('hi')
})
