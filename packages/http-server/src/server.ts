import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createAdaptorServer } from '@hono/node-server'
import { Disposer } from '@sozai/async'
import { getSozaiLogger, type Logger } from '@sozai/log'
import { createTracerFactory, type Tracer } from '@sozai/otel'
import getPort, { type Options as GetPortOptions } from 'get-port'
import type { Hono } from 'hono'

import { assembleApp } from './app.js'
import { createTrustMatcher, type TrustMatcher } from './client-ip.js'
import { sortPlugins } from './graph.js'
import { HealthRoutes, type HealthRoutesParams } from './health.js'
import { LimitsTable } from './limits.js'
import { PluginRegistrar } from './registrar.js'
import { runHooks } from './shutdown.js'
import type { AnyHTTPPlugin, ShutdownReport, TrustProxy } from './types.js'

const DEFAULT_PORT = 3000
const DEFAULT_BODY_BYTES = 1_048_576
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_GRACE_MS = 10_000
const DEFAULT_CLOSE_HOOK_TIMEOUT_MS = 5_000

export type CreateServerParams = {
  plugins?: Array<AnyHTTPPlugin>
  /** A fixed port, or `get-port` options to pick a free one. Defaults to 3000 when free. */
  port?: number | GetPortOptions
  hostname?: string
  trustProxy?: TrustProxy
  limits?: { bodyBytes?: number; requestTimeoutMs?: number }
  health?: { livePath?: string; readyPath?: string; checkTimeoutMs?: number; log?: boolean }
  /** Time allowed for shutdown hooks and in-flight responses before sockets are destroyed. */
  graceMs?: number
  /** Default budget for each close hook. */
  closeHookTimeoutMs?: number
  logger?: Logger
  tracer?: Tracer
  signal?: AbortSignal
}

export type HTTPServerParams = {
  port?: number | GetPortOptions
  hostname?: string
  trustMatcher: TrustMatcher
  limits: LimitsTable
  health?: Omit<HealthRoutesParams, 'isShuttingDown'>
  graceMs: number
  closeHookTimeoutMs: number
  logger: Logger
  tracer: Tracer
  signal?: AbortSignal
}

let setupServer: (server: HTTPServer, plugins: Array<AnyHTTPPlugin>) => Promise<void>

export class HTTPServer extends Disposer {
  static {
    // Lets createServer drive plugin setup without exposing it on the public API.
    setupServer = (server, plugins) => server.#setup(plugins)
  }

  #port: number | GetPortOptions | undefined
  #hostname: string | undefined
  #trustMatcher: TrustMatcher
  #limits: LimitsTable
  #health: HealthRoutes
  #graceMs: number
  #closeHookTimeoutMs: number
  #logger: Logger
  #tracer: Tracer
  #parentSignal: AbortSignal | undefined
  #registrars: Array<PluginRegistrar> = []
  #setupInProgress: Promise<unknown> | undefined
  #app: Hono | undefined
  #server: Server | undefined
  #url: string | undefined
  #responses = new Set<ServerResponse>()
  #onDrained: (() => void) | undefined
  #shuttingDown = false
  #shutdownReport: ShutdownReport | undefined

  constructor(params: HTTPServerParams) {
    super({
      dispose: (reason) => this.#shutdown(reason),
      onDisposeError: (error) => {
        params.logger.error('HTTP server shutdown failed', { error })
      },
      signal: params.signal,
    })
    this.#port = params.port
    this.#hostname = params.hostname
    this.#trustMatcher = params.trustMatcher
    this.#limits = params.limits
    this.#health = new HealthRoutes({
      ...params.health,
      isShuttingDown: () => this.#shuttingDown,
    })
    this.#graceMs = params.graceMs
    this.#closeHookTimeoutMs = params.closeHookTimeoutMs
    this.#logger = params.logger
    this.#tracer = params.tracer
    this.#parentSignal = params.signal
  }

  get app(): Hono {
    if (this.#app == null) {
      throw new Error('Server is not set up')
    }
    return this.#app
  }

  get url(): string {
    if (this.#url == null) {
      throw new Error('Server is not listening')
    }
    return this.#url
  }

  get shutdownReport(): ShutdownReport | undefined {
    return this.#shutdownReport
  }

  async listen(): Promise<void> {
    if (this.signal.aborted) {
      throw new Error('Server is disposed')
    }
    if (this.#server != null) {
      throw new Error('Server is already listening')
    }
    const app = this.app
    const port =
      typeof this.#port === 'number'
        ? this.#port
        : await getPort(this.#port ?? { port: DEFAULT_PORT })
    if (this.signal.aborted) {
      throw new Error('Server is disposed')
    }

    const server = createAdaptorServer({ fetch: app.fetch }) as Server
    server.on('request', (_req, res: ServerResponse) => {
      this.#responses.add(res)
      res.on('close', () => {
        this.#responses.delete(res)
        if (this.#responses.size === 0) {
          this.#onDrained?.()
        }
      })
    })
    this.#server = server

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, this.#hostname, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      await this.dispose(error)
      throw error
    }
    if (this.signal.aborted) {
      // Shutdown began while binding; it already closed the server.
      throw new Error('Server is disposed')
    }

    const { port: boundPort } = server.address() as AddressInfo
    const host = this.#hostname ?? 'localhost'
    this.#url = `http://${host.includes(':') ? `[${host}]` : host}:${boundPort}`
    this.#logger.info('HTTP server listening', { url: this.#url })
  }

  close(reason?: unknown): Promise<void> {
    return this.dispose(reason)
  }

  /** Dispose on `SIGTERM` or `SIGINT`. Returns a function removing the listeners. */
  handleSignals(): () => void {
    const onSignal = (signal: NodeJS.Signals) => {
      void this.dispose(signal)
    }
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
    return () => {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
    }
  }

  async #setup(plugins: Array<AnyHTTPPlugin>): Promise<void> {
    const exports = new Map<string, unknown>()
    for (const plugin of plugins) {
      // The parent signal is checked directly: an already aborted one only disposes
      // this server on the next microtask.
      if (this.signal.aborted || this.#parentSignal?.aborted) {
        return
      }
      const registrar = new PluginRegistrar({
        plugin: plugin.name,
        logger: this.#logger,
        tracer: this.#tracer,
        signal: this.signal,
        exports,
        dependsOn: plugin.dependsOn,
        limits: this.#limits,
        reservedPaths: this.#health.paths,
        trustMatcher: this.#trustMatcher,
      })
      this.#registrars.push(registrar)
      const setup = Promise.resolve().then(() => plugin.setup(registrar.context))
      this.#setupInProgress = setup
      try {
        exports.set(plugin.name, await setup)
      } finally {
        this.#setupInProgress = undefined
        registrar.seal()
      }
      for (const check of registrar.readinessChecks) {
        this.#health.addCheck(plugin.name, check)
      }
    }
    this.#app = assembleApp({
      registrars: this.#registrars,
      health: this.#health,
      trustMatcher: this.#trustMatcher,
      limits: this.#limits,
      logger: this.#logger,
      tracer: this.#tracer,
    })
  }

  async #shutdown(reason: unknown): Promise<void> {
    this.#shuttingDown = true
    this.#logger.info('HTTP server shutting down', { reason })
    // Hooks registered by a setup still running must be collected before they run.
    await this.#setupInProgress?.catch(() => {})

    const deadline = performance.now() + this.#graceMs
    const remaining = () => Math.max(0, deadline - performance.now())
    const server = this.#server
    server?.close()

    const shutdownHooks = await runHooks(
      this.#registrars.flatMap((registrar) => {
        return registrar.shutdownHooks.map((fn) => {
          return { plugin: registrar.plugin, fn, timeoutMs: remaining() }
        })
      }),
      'concurrent',
      this.#logger,
    )

    let forced = false
    if (!(await this.#waitForDrain(remaining()))) {
      forced = true
      this.#logger.warn('HTTP server grace period expired, closing open connections', {
        openResponses: this.#responses.size,
      })
      server?.closeAllConnections()
    }
    server?.closeIdleConnections()

    const closeHooks = await runHooks(
      this.#registrars.toReversed().flatMap((registrar) => {
        return registrar.closeHooks.toReversed().map((hook) => {
          return {
            plugin: registrar.plugin,
            fn: hook.fn,
            timeoutMs: hook.timeoutMs ?? this.#closeHookTimeoutMs,
          }
        })
      }),
      'serial',
      this.#logger,
    )

    this.#shutdownReport = { forced, hooks: [...shutdownHooks, ...closeHooks] }
    this.#logger.info('HTTP server closed', { forced })
  }

  #waitForDrain(timeoutMs: number): Promise<boolean> {
    if (this.#responses.size === 0) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#onDrained = undefined
        resolve(false)
      }, timeoutMs)
      this.#onDrained = () => {
        clearTimeout(timer)
        this.#onDrained = undefined
        resolve(true)
      }
    })
  }
}

/**
 * Create an HTTP server, running every plugin's setup in dependency order. A setup
 * failure or a parent abort disposes the server, running the hooks registered so far.
 */
export async function createServer(params: CreateServerParams = {}): Promise<HTTPServer> {
  const plugins = sortPlugins(params.plugins ?? [])
  const server = new HTTPServer({
    port: params.port,
    hostname: params.hostname,
    trustMatcher: createTrustMatcher(params.trustProxy ?? false),
    limits: new LimitsTable({
      defaults: {
        bodyBytes: params.limits?.bodyBytes ?? DEFAULT_BODY_BYTES,
        timeoutMs: params.limits?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      },
    }),
    health: params.health,
    graceMs: params.graceMs ?? DEFAULT_GRACE_MS,
    closeHookTimeoutMs: params.closeHookTimeoutMs ?? DEFAULT_CLOSE_HOOK_TIMEOUT_MS,
    logger: params.logger ?? getSozaiLogger('http-server'),
    tracer: params.tracer ?? createTracerFactory('sozai')('http-server'),
    signal: params.signal,
  })

  try {
    await setupServer(server, plugins)
  } catch (error) {
    await server.dispose(error)
    throw error
  }
  if (server.signal.aborted || params.signal?.aborted) {
    await server.disposed
    throw server.signal.reason
  }
  return server
}
