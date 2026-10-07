import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { timeout } from 'hono/timeout'

import type { Limits } from './types.js'

export type ResolvedLimits = { bodyBytes: number | false; timeoutMs: number | false }

export type LimitsTableParams = { defaults: ResolvedLimits }

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
}

export class LimitsTable {
  #defaults: ResolvedLimits
  #overrides = new Map<string, Limits>()

  constructor(params: LimitsTableParams) {
    this.#defaults = params.defaults
  }

  set(pathPrefix: string, overrides: Limits): void {
    this.#overrides.set(pathPrefix, { ...this.#overrides.get(pathPrefix), ...overrides })
  }

  resolve(path: string): ResolvedLimits {
    const matching = [...this.#overrides.entries()]
      .filter(([prefix]) => matchesPrefix(path, prefix))
      .sort((a, b) => a[0].length - b[0].length)
    const resolved = { ...this.#defaults }
    for (const [, limits] of matching) {
      if (limits.bodyBytes !== undefined) {
        resolved.bodyBytes = limits.bodyBytes
      }
      if (limits.timeoutMs !== undefined) {
        resolved.timeoutMs = limits.timeoutMs
      }
    }
    return resolved
  }
}

/**
 * Create a middleware applying the body size limit and response deadline resolved
 * for each request path.
 */
export function createLimitsMiddleware(table: LimitsTable): MiddlewareHandler {
  const bodyLimits = new Map<number, MiddlewareHandler>()
  const timeouts = new Map<number, MiddlewareHandler>()

  return async (c, next) => {
    const { bodyBytes, timeoutMs } = table.resolve(c.req.path)

    const applyTimeout = async (): Promise<void> => {
      if (timeoutMs === false) {
        await next()
        return
      }
      let handler = timeouts.get(timeoutMs)
      if (handler == null) {
        handler = timeout(timeoutMs)
        timeouts.set(timeoutMs, handler)
      }
      await handler(c, next)
    }

    if (bodyBytes === false) {
      return await applyTimeout()
    }
    let handler = bodyLimits.get(bodyBytes)
    if (handler == null) {
      handler = bodyLimit({ maxSize: bodyBytes })
      bodyLimits.set(bodyBytes, handler)
    }
    return await handler(c, applyTimeout)
  }
}
