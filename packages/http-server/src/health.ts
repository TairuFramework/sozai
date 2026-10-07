import type { Hono } from 'hono'

import type { ReadinessCheck } from './registrar.js'

const DEFAULT_LIVE_PATH = '/health/live'
const DEFAULT_READY_PATH = '/health/ready'
const DEFAULT_CHECK_TIMEOUT_MS = 2000

export type HealthRoutesParams = {
  livePath?: string
  readyPath?: string
  checkTimeoutMs?: number
  log?: boolean
  isShuttingDown: () => boolean
}

/** Liveness and readiness routes, aggregating readiness checks per plugin. */
export class HealthRoutes {
  #livePath: string
  #readyPath: string
  #checkTimeoutMs: number
  #log: boolean
  #isShuttingDown: () => boolean
  #checks = new Map<string, Array<ReadinessCheck>>()

  constructor(params: HealthRoutesParams) {
    this.#livePath = params.livePath ?? DEFAULT_LIVE_PATH
    this.#readyPath = params.readyPath ?? DEFAULT_READY_PATH
    this.#checkTimeoutMs = params.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
    this.#log = params.log ?? false
    this.#isShuttingDown = params.isShuttingDown
  }

  get paths(): Array<string> {
    return [this.#livePath, this.#readyPath]
  }

  get log(): boolean {
    return this.#log
  }

  addCheck(plugin: string, check: ReadinessCheck): void {
    const checks = this.#checks.get(plugin)
    if (checks == null) {
      this.#checks.set(plugin, [check])
    } else {
      checks.push(check)
    }
  }

  register(app: Hono): void {
    app.get(this.#livePath, (c) => c.json({ status: 'ok' }))
    app.get(this.#readyPath, async (c) => {
      if (this.#isShuttingDown()) {
        return c.json({ status: 'shutting-down', checks: {} }, 503)
      }
      const entries = await Promise.all(
        Array.from(this.#checks, async ([plugin, checks]) => {
          const results = await Promise.all(checks.map((check) => this.#run(check)))
          return [plugin, results.every(Boolean)] as const
        }),
      )
      const checks = Object.fromEntries(entries)
      const ok = entries.every(([, passed]) => passed)
      return c.json({ status: ok ? 'ok' : 'unavailable', checks }, ok ? 200 : 503)
    })
  }

  async #run(check: ReadinessCheck): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.#checkTimeoutMs)
    })
    try {
      return await Promise.race([Promise.resolve().then(check), timeout])
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }
}
