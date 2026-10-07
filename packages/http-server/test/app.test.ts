import { getLogger, type Logger } from '@sozai/log'
import { createTracerFactory } from '@sozai/otel'
import type { Handler, Hono, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, test, vi } from 'vitest'

import { assembleApp } from '../src/app.js'
import { createTrustMatcher } from '../src/client-ip.js'
import { LimitsTable } from '../src/limits.js'
import { PluginRegistrar } from '../src/registrar.js'
import type { TrustProxy } from '../src/types.js'

const logger = getLogger(['sozai', 'http-server', 'test'])
const tracer = createTracerFactory('sozai.test')('http-server')
const health = { paths: [], register() {} }

type RegistrarOptions = {
  plugin?: string
  dependsOn?: Array<string>
  exports?: Map<string, unknown>
  reservedPaths?: Array<string>
  trustProxy?: TrustProxy
  limits?: LimitsTable
}

function createLimits(): LimitsTable {
  return new LimitsTable({ defaults: { bodyBytes: 1024, timeoutMs: false } })
}

function createRegistrar(options: RegistrarOptions = {}): PluginRegistrar {
  return new PluginRegistrar({
    plugin: options.plugin ?? 'test:plugin',
    logger,
    tracer,
    signal: new AbortController().signal,
    exports: options.exports ?? new Map(),
    dependsOn: options.dependsOn ?? [],
    limits: options.limits ?? createLimits(),
    reservedPaths: options.reservedPaths ?? [],
    trustMatcher: createTrustMatcher(options.trustProxy ?? false),
  })
}

function assemble(registrars: Array<PluginRegistrar>, trustProxy: TrustProxy = false): Hono {
  for (const registrar of registrars) {
    registrar.seal()
  }
  return assembleApp({
    registrars,
    health,
    trustMatcher: createTrustMatcher(trustProxy),
    limits: createLimits(),
    logger,
    tracer,
  })
}

const ok: Handler = (c) => c.text('ok')

describe('assembleApp', () => {
  test('middleware from a later plugin applies to routes of an earlier plugin', async () => {
    const a = createRegistrar({ plugin: 'a' })
    a.context.route('get', '/a', (c) => c.text('a'))
    const b = createRegistrar({ plugin: 'b' })
    b.context.middleware(async (c) => c.text('blocked', 429))

    const res = await assemble([a, b]).request('/a')
    expect(res.status).toBe(429)
  })

  test('route-scoped middleware does not gate sibling routes', async () => {
    const guard: MiddlewareHandler = (c) => Promise.resolve(c.text('denied', 401))
    const a = createRegistrar({ plugin: 'a' })
    a.context.route('get', '/a', guard, ok)
    const b = createRegistrar({ plugin: 'b' })
    b.context.route('get', '/b', ok)

    const app = assemble([a, b])
    expect((await app.request('/a')).status).toBe(401)
    expect((await app.request('/b')).status).toBe(200)
  })

  test('errors use the core envelope', async () => {
    const a = createRegistrar()
    a.context.route('get', '/boom', () => {
      throw new Error('boom')
    })

    const res = await assemble([a]).request('/boom')
    expect(res.status).toBe(500)
    const requestID = res.headers.get('X-Request-Id')
    expect(requestID).toBeTruthy()
    const body = await res.text()
    expect(body).not.toContain('boom')
    expect(JSON.parse(body)).toEqual({ error: 'Internal Server Error', requestID })
  })

  test('HTTPException passes through', async () => {
    const a = createRegistrar()
    a.context.route('get', '/tea', () => {
      throw new HTTPException(418, { message: 'tea' })
    })

    const res = await assemble([a]).request('/tea')
    expect(res.status).toBe(418)
  })

  test('unknown paths return the core 404', async () => {
    const res = await assemble([]).request('/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not Found' })
  })

  test('incoming request IDs are honoured only from trusted peers', async () => {
    const env = { incoming: { socket: { remoteAddress: '10.0.0.1' } } }
    const init = { headers: { 'X-Request-Id': 'abc' } }

    const untrusted = await assemble([], false).request('/', init, env)
    expect(untrusted.headers.get('X-Request-Id')).not.toBe('abc')

    const trusted = await assemble([], 1).request('/', init, env)
    expect(trusted.headers.get('X-Request-Id')).toBe('abc')

    const cidr = await assemble([], ['10.0.0.0/8']).request('/', init, env)
    expect(cidr.headers.get('X-Request-Id')).toBe('abc')

    const outside = await assemble([], ['192.168.0.0/16']).request('/', init, env)
    expect(outside.headers.get('X-Request-Id')).not.toBe('abc')
  })

  test('access log skips health paths unless enabled', async () => {
    const info = vi.fn()
    const spyLogger = { info, error: vi.fn() } as unknown as Logger
    const createApp = (log: boolean): Hono => {
      const a = createRegistrar()
      a.context.route('get', '/a', ok)
      a.seal()
      return assembleApp({
        registrars: [a],
        health: {
          paths: ['/health/live'],
          log,
          register(app) {
            app.get('/health/live', ok)
          },
        },
        trustMatcher: createTrustMatcher(false),
        limits: createLimits(),
        logger: spyLogger,
        tracer,
      })
    }

    const quiet = createApp(false)
    await quiet.request('/health/live')
    expect(info).not.toHaveBeenCalled()
    await quiet.request('/a')
    expect(info).toHaveBeenCalledWith(
      'HTTP request',
      expect.objectContaining({ method: 'GET', path: '/a', status: 200 }),
    )

    info.mockClear()
    await createApp(true).request('/health/live')
    expect(info).toHaveBeenCalledWith(
      'HTTP request',
      expect.objectContaining({ path: '/health/live', status: 200 }),
    )
  })

  test('malformed incoming request IDs are replaced', async () => {
    const env = { incoming: { socket: { remoteAddress: '10.0.0.1' } } }
    const res = await assemble([], 1).request('/', { headers: { 'X-Request-Id': 'a=b' } }, env)
    expect(res.headers.get('X-Request-Id')).not.toBe('a=b')
  })

  test('client IP comes from the socket peer and trusted forwarding headers', async () => {
    const env = { incoming: { socket: { remoteAddress: '10.0.0.1' } } }
    const init = { headers: { 'X-Forwarded-For': '1.2.3.4' } }

    const direct = createRegistrar({ trustProxy: false })
    direct.context.route('get', '/ip', (c) => c.text(direct.context.clientIP(c)))
    expect(await (await assemble([direct]).request('/ip', init, env)).text()).toBe('10.0.0.1')

    const proxied = createRegistrar({ trustProxy: ['10.0.0.0/8'] })
    proxied.context.route('get', '/ip', (c) => c.text(proxied.context.clientIP(c)))
    expect(await (await assemble([proxied]).request('/ip', init, env)).text()).toBe('1.2.3.4')
  })
})

describe('PluginRegistrar', () => {
  test('registration after setup throws', () => {
    const registrar = createRegistrar({ plugin: 'late' })
    registrar.seal()
    expect(() => registrar.context.route('get', '/x', ok)).toThrow(
      'Plugin "late" registered after setup',
    )
    expect(() => registrar.context.middleware((_c, next) => next())).toThrow('after setup')
    expect(() => registrar.context.onClose(() => {})).toThrow('after setup')
  })

  test('use rejects undeclared dependencies', () => {
    const registrar = createRegistrar({
      plugin: 'consumer',
      dependsOn: ['x'],
      exports: new Map<string, unknown>([
        ['x', 1],
        ['y', 2],
      ]),
    })
    expect(registrar.context.use('x')).toBe(1)
    expect(() => registrar.context.use('y')).toThrow(
      'Plugin "consumer" did not declare dependency "y"',
    )
  })

  test('routes colliding with health paths are rejected', () => {
    const registrar = createRegistrar({ plugin: 'p', reservedPaths: ['/health/ready'] })
    expect(() => registrar.context.route('get', '/health/ready/', ok)).toThrow(
      'Plugin "p" route "/health/ready/" collides with a reserved health path',
    )
    expect(() => registrar.context.route('get', '/health/ready', ok)).toThrow(
      'reserved health path',
    )
  })

  test('records hooks and limits', () => {
    const limits = createLimits()
    const registrar = createRegistrar({ limits })
    const check = () => true
    const shutdown = () => {}
    const close = () => {}
    registrar.context.addReadinessCheck(check)
    registrar.context.onShutdown(shutdown)
    registrar.context.onClose(close, { timeoutMs: 50 })
    registrar.context.limits('/upload', { bodyBytes: false })

    expect(registrar.readinessChecks).toEqual([check])
    expect(registrar.shutdownHooks).toEqual([shutdown])
    expect(registrar.closeHooks).toEqual([{ fn: close, timeoutMs: 50 }])
    expect(limits.resolve('/upload').bodyBytes).toBe(false)
  })
})

describe('createTrustMatcher', () => {
  test('rejects malformed entries when compiled', () => {
    expect(() => createTrustMatcher(['10.0.0.0/abc'])).toThrow(
      'Invalid trustProxy entry "10.0.0.0/abc"',
    )
    expect(() => createTrustMatcher(['10.0.0.0/33'])).toThrow('Invalid trustProxy entry')
    expect(() => createTrustMatcher(['not-an-ip'])).toThrow('Invalid trustProxy entry')
    expect(() => createTrustMatcher(['10.0.0.0/8/1'])).toThrow('Invalid trustProxy entry')
    expect(() => createTrustMatcher(-1)).toThrow('Invalid trustProxy entry "-1"')
  })

  test('accepts valid entries', () => {
    const matcher = createTrustMatcher(['10.0.0.0/8', 'fd00::/8', '127.0.0.1'])
    expect(matcher.isTrusted('10.1.2.3')).toBe(true)
    expect(matcher.isTrusted('::ffff:127.0.0.1')).toBe(true)
    expect(matcher.isTrusted('8.8.8.8')).toBe(false)
  })
})
