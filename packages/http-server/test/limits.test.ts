import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'

import { createLimitsMiddleware, LimitsTable } from '../src/limits.js'

describe('LimitsTable', () => {
  test('resolves defaults when nothing matches', () => {
    const defaults = { bodyBytes: 100, timeoutMs: 50 }
    const table = new LimitsTable({ defaults })
    expect(table.resolve('/x')).toEqual(defaults)
  })

  test('longest prefix wins and missing fields inherit', () => {
    const defaults = { bodyBytes: 100, timeoutMs: 50 }
    const table = new LimitsTable({ defaults })
    table.set('/rpc', { bodyBytes: false })
    table.set('/rpc/admin', { timeoutMs: 10 })
    expect(table.resolve('/rpc/admin/y')).toEqual({ bodyBytes: false, timeoutMs: 10 })
    expect(table.resolve('/rpc/x')).toEqual({ bodyBytes: false, timeoutMs: 50 })
    expect(table.resolve('/rpcx')).toEqual(defaults)
  })
})

describe('createLimitsMiddleware', () => {
  function createApp(table: LimitsTable, delayMs = 0): Hono {
    const app = new Hono()
    app.use(createLimitsMiddleware(table))
    app.post('*', async (c) => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      return c.text('ok')
    })
    return app
  }

  test('middleware rejects oversized bodies with 413', async () => {
    const table = new LimitsTable({ defaults: { bodyBytes: 4, timeoutMs: false } })
    const res = await createApp(table).request('/', { method: 'POST', body: '12345' })
    expect(res.status).toBe(413)
  })

  test('middleware skips the body limit when disabled for the path', async () => {
    const table = new LimitsTable({ defaults: { bodyBytes: 4, timeoutMs: false } })
    table.set('/big', { bodyBytes: false })
    const res = await createApp(table).request('/big', { method: 'POST', body: '1234567890' })
    expect(res.status).toBe(200)
  })

  test('middleware applies the response deadline', async () => {
    const table = new LimitsTable({ defaults: { bodyBytes: false, timeoutMs: 20 } })
    const res = await createApp(table, 100).request('/', { method: 'POST', body: 'x' })
    expect(res.status).toBe(504)
  })
})
