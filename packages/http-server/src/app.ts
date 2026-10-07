import { httpInstrumentationMiddleware } from '@hono/otel'
import type { Logger } from '@sozai/log'
import type { Tracer } from '@sozai/otel'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'

import type { TrustMatcher } from './client-ip.js'
import type { HealthRoutes } from './health.js'
import { createLimitsMiddleware, type LimitsTable } from './limits.js'
import {
  accessLogMiddleware,
  errorHandler,
  notFoundHandler,
  requestIDMiddleware,
} from './middleware.js'
import { stripTrailingSlash } from './path.js'
import type { PluginRegistrar } from './registrar.js'

export type AssembleAppParams = {
  registrars: Array<PluginRegistrar>
  health: HealthRoutes
  trustMatcher: TrustMatcher
  limits: LimitsTable
  logger: Logger
  tracer: Tracer
}

/**
 * Build the root Hono app: core middleware, then health routes, then every plugin's
 * middleware, then every plugin's routes, so middleware from any plugin applies to
 * routes from all plugins.
 */
export function assembleApp(params: AssembleAppParams): Hono {
  const { registrars, health, trustMatcher, limits, logger, tracer } = params
  const app = new Hono()

  app.use(requestIDMiddleware(trustMatcher))
  app.use(httpInstrumentationMiddleware({ tracer }))
  app.use(secureHeaders())
  const accessLog = accessLogMiddleware(logger)
  if (health.log) {
    app.use(accessLog)
  } else {
    const healthPaths = new Set(health.paths.map(stripTrailingSlash))
    app.use(async (c, next) => {
      if (healthPaths.has(stripTrailingSlash(c.req.path))) {
        await next()
        return
      }
      await accessLog(c, next)
    })
  }
  app.use(createLimitsMiddleware(limits))

  health.register(app)

  for (const registrar of registrars) {
    for (const { handler, path } of registrar.middleware) {
      if (path == null) {
        app.use(handler)
      } else {
        const base = stripTrailingSlash(path)
        app.use(base === '/' ? '/*' : `${base}/*`, handler)
      }
    }
  }

  for (const registrar of registrars) {
    for (const { method, path, handlers } of registrar.routes) {
      app.on(method.toUpperCase(), [path], ...handlers)
    }
  }

  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler)
  return app
}
