import { getLogger } from '@sozai/log'
import { createTracerFactory } from '@sozai/otel'
import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'

import { assembleApp } from '../src/app.js'
import { createTrustMatcher } from '../src/client-ip.js'
import { HealthRoutes } from '../src/health.js'
import { LimitsTable } from '../src/limits.js'
import { PluginRegistrar } from '../src/registrar.js'

type Body = { status: string; checks: Record<string, boolean> }

function createApp(
  setup: (health: HealthRoutes) => void,
  params: { checkTimeoutMs?: number; shuttingDown?: boolean } = {},
): Hono {
  const health = new HealthRoutes({
    checkTimeoutMs: params.checkTimeoutMs,
    isShuttingDown: () => params.shuttingDown ?? false,
  })
  setup(health)
  const app = new Hono()
  health.register(app)
  return app
}

describe('HealthRoutes', () => {
  test('live returns 200', async () => {
    const res = await createApp(() => {}).request('/health/live')
    expect(res.status).toBe(200)
  })

  test('exposes configured paths and log flag', () => {
    const health = new HealthRoutes({
      livePath: '/l',
      readyPath: '/r',
      log: true,
      isShuttingDown: () => false,
    })
    expect(health.paths).toEqual(['/l', '/r'])
    expect(health.log).toBe(true)
    expect(new HealthRoutes({ isShuttingDown: () => false }).log).toBe(false)
  })

  test('ready aggregates checks per plugin', async () => {
    const app = createApp((health) => {
      health.addCheck('a', () => true)
      health.addCheck('a', async () => true)
      health.addCheck('b', () => false)
    })
    const res = await app.request('/health/ready')
    expect(res.status).toBe(503)
    const body = (await res.json()) as Body
    expect(body.status).toBe('unavailable')
    expect(body.checks).toEqual({ a: true, b: false })
  })

  test('ready returns 200 when all checks pass', async () => {
    const app = createApp((health) => health.addCheck('a', () => true))
    const res = await app.request('/health/ready')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', checks: { a: true } })
  })

  test('a throwing check counts as failing', async () => {
    const app = createApp((health) =>
      health.addCheck('a', () => {
        throw new Error('boom')
      }),
    )
    const res = await app.request('/health/ready')
    expect(res.status).toBe(503)
    expect(((await res.json()) as Body).checks.a).toBe(false)
  })

  test('a slow check times out', async () => {
    const app = createApp(
      (health) =>
        health.addCheck(
          'a',
          () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100)),
        ),
      { checkTimeoutMs: 20 },
    )
    const res = await app.request('/health/ready')
    expect(res.status).toBe(503)
    expect(((await res.json()) as Body).checks.a).toBe(false)
  })

  test('ready reports shutting-down', async () => {
    let ran = false
    const app = createApp(
      (health) =>
        health.addCheck('a', () => {
          ran = true
          return true
        }),
      { shuttingDown: true },
    )
    const res = await app.request('/health/ready')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'shutting-down', checks: {} })
    expect(ran).toBe(false)
  })

  test('plugin catch-all routes do not shadow health', async () => {
    const logger = getLogger(['sozai', 'http-server', 'test'])
    const tracer = createTracerFactory('sozai.test')('http-server')
    const limits = new LimitsTable({ defaults: { bodyBytes: 1024, timeoutMs: false } })
    const health = new HealthRoutes({ isShuttingDown: () => false })
    const registrar = new PluginRegistrar({
      plugin: 'a',
      logger,
      tracer,
      signal: new AbortController().signal,
      exports: new Map(),
      dependsOn: [],
      limits,
      reservedPaths: health.paths,
      trustMatcher: createTrustMatcher(false),
    })
    registrar.context.route('all', '*', (c) => c.text('x'))
    registrar.context.middleware(async (c) => c.text('limited', 429))
    registrar.seal()
    const app = assembleApp({
      registrars: [registrar],
      health,
      trustMatcher: createTrustMatcher(false),
      limits,
      logger,
      tracer,
    })

    expect((await app.request('/health/live')).status).toBe(200)
    expect((await app.request('/health/ready')).status).toBe(200)
    expect((await app.request('/other')).status).toBe(429)
  })
})
