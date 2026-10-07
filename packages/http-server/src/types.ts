import type { Logger } from '@sozai/log'
import type { Tracer } from '@sozai/otel'
import type { Context, Handler, MiddlewareHandler } from 'hono'

export type PluginName<Name extends string, Exports> = Name & { readonly __exports?: Exports }
export type AnyPluginName = PluginName<string, unknown>
export type ExportsOf<T> = T extends PluginName<string, infer E> ? E : never

export type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'all'
export type Limits = { bodyBytes?: number | false; timeoutMs?: number | false }
export type TrustProxy = false | number | Array<string>
export type HookOutcome = 'completed' | 'failed' | 'timed-out'
export type ShutdownReport = {
  forced: boolean
  hooks: Array<{ plugin: string; phase: 'shutdown' | 'close'; outcome: HookOutcome }>
}

export type PluginContext<Deps extends ReadonlyArray<AnyPluginName>> = {
  route(method: RouteMethod, path: string, ...handlers: Array<Handler | MiddlewareHandler>): void
  middleware(handler: MiddlewareHandler, path?: string): void
  limits(pathPrefix: string, overrides: Limits): void
  clientIP(c: Context): string
  logger: Logger
  tracer: Tracer
  signal: AbortSignal
  addReadinessCheck(check: () => boolean | Promise<boolean>): void
  onShutdown(fn: () => void | Promise<void>): void
  onClose(fn: () => void | Promise<void>, opts?: { timeoutMs?: number }): void
  use<D extends Deps[number]>(name: D): ExportsOf<D>
}

export type HTTPPlugin<Name extends string, Exports, Deps extends ReadonlyArray<AnyPluginName>> = {
  name: PluginName<Name, Exports>
  dependsOn: Deps
  setup(ctx: PluginContext<Deps>): Exports | Promise<Exports>
}

export type AnyHTTPPlugin = {
  name: string
  dependsOn: ReadonlyArray<string>
  setup(ctx: PluginContext<ReadonlyArray<AnyPluginName>>): unknown
}
