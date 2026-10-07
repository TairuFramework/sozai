import type { Logger } from '@sozai/log'
import type { Tracer } from '@sozai/otel'
import type { Handler, MiddlewareHandler } from 'hono'

import type { TrustMatcher } from './client-ip.js'
import type { LimitsTable } from './limits.js'
import { getClientIP } from './middleware.js'
import type { AnyPluginName, PluginContext, RouteMethod } from './types.js'

export type RouteRegistration = {
  method: RouteMethod
  path: string
  handlers: Array<Handler | MiddlewareHandler>
}

export type MiddlewareRegistration = {
  handler: MiddlewareHandler
  path: string | undefined
}

export type ReadinessCheck = () => boolean | Promise<boolean>
export type ShutdownHook = () => void | Promise<void>
export type CloseHook = { fn: () => void | Promise<void>; timeoutMs?: number }

export type PluginRegistrarParams = {
  plugin: string
  logger: Logger
  tracer: Tracer
  signal: AbortSignal
  exports: Map<string, unknown>
  dependsOn: ReadonlyArray<string>
  limits: LimitsTable
  reservedPaths: ReadonlyArray<string>
  trustMatcher: TrustMatcher
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * Record the registrations a single plugin makes during setup, exposing them through
 * the plugin context until sealed.
 */
export class PluginRegistrar {
  #plugin: string
  #exports: Map<string, unknown>
  #dependsOn: Set<string>
  #limits: LimitsTable
  #reservedPaths: Set<string>
  #sealed = false
  #routes: Array<RouteRegistration> = []
  #middleware: Array<MiddlewareRegistration> = []
  #readinessChecks: Array<ReadinessCheck> = []
  #shutdownHooks: Array<ShutdownHook> = []
  #closeHooks: Array<CloseHook> = []
  #context: PluginContext<ReadonlyArray<AnyPluginName>>

  constructor(params: PluginRegistrarParams) {
    this.#plugin = params.plugin
    this.#exports = params.exports
    this.#dependsOn = new Set(params.dependsOn)
    this.#limits = params.limits
    this.#reservedPaths = new Set(params.reservedPaths.map(stripTrailingSlash))
    const trustMatcher = params.trustMatcher

    this.#context = {
      route: (method, path, ...handlers) => {
        this.#assertOpen()
        if (this.#reservedPaths.has(stripTrailingSlash(path))) {
          throw new Error(
            `Plugin "${this.#plugin}" route "${path}" collides with a reserved health path`,
          )
        }
        this.#routes.push({ method, path, handlers })
      },
      middleware: (handler, path) => {
        this.#assertOpen()
        this.#middleware.push({ handler, path })
      },
      limits: (pathPrefix, overrides) => {
        this.#assertOpen()
        this.#limits.set(pathPrefix, overrides)
      },
      clientIP: (c) => getClientIP(c, trustMatcher),
      logger: params.logger,
      tracer: params.tracer,
      signal: params.signal,
      addReadinessCheck: (check) => {
        this.#assertOpen()
        this.#readinessChecks.push(check)
      },
      onShutdown: (fn) => {
        this.#assertOpen()
        this.#shutdownHooks.push(fn)
      },
      onClose: (fn, opts) => {
        this.#assertOpen()
        this.#closeHooks.push(opts?.timeoutMs == null ? { fn } : { fn, timeoutMs: opts.timeoutMs })
      },
      use: (name) => {
        if (!this.#dependsOn.has(name)) {
          throw new Error(`Plugin "${this.#plugin}" did not declare dependency "${name}"`)
        }
        return this.#exports.get(name) as never
      },
    }
  }

  get context(): PluginContext<ReadonlyArray<AnyPluginName>> {
    return this.#context
  }

  get routes(): Array<RouteRegistration> {
    return this.#routes
  }

  get middleware(): Array<MiddlewareRegistration> {
    return this.#middleware
  }

  get readinessChecks(): Array<ReadinessCheck> {
    return this.#readinessChecks
  }

  get shutdownHooks(): Array<ShutdownHook> {
    return this.#shutdownHooks
  }

  get closeHooks(): Array<CloseHook> {
    return this.#closeHooks
  }

  /** Reject any further registration through the plugin context. */
  seal(): void {
    this.#sealed = true
  }

  #assertOpen(): void {
    if (this.#sealed) {
      throw new Error(`Plugin "${this.#plugin}" registered after setup`)
    }
  }
}
