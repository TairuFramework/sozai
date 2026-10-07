export { createTrustMatcher, type TrustMatcher } from './client-ip.js'
export { PluginGraphError, type PluginGraphErrorParams } from './graph.js'
export { getClientIP } from './middleware.js'
export { definePlugin, pluginName } from './plugin.js'
export { type CreateServerParams, createServer, type HTTPServer } from './server.js'
export type {
  AnyHTTPPlugin,
  AnyPluginName,
  ExportsOf,
  HookOutcome,
  HTTPPlugin,
  Limits,
  PluginContext,
  PluginName,
  RouteMethod,
  ShutdownReport,
  TrustProxy,
} from './types.js'
