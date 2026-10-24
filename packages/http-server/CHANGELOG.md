# @sozai/http-server

## 0.2.1

### Patch Changes

- Add `transportInfo`, `isLoopbackAddress` and `isSecureTransport`: socket transport facts (TLS, local and remote address) read from the Node connection, never from request headers, and a loopback check for both ends.

## 0.2.0

### Minor Changes

- Depend on `@sozai/otel` ^0.4.0, which requires `@opentelemetry/api` ^1.10.0. Align a directly-installed `@sozai/otel` to ^0.4.0 to avoid duplicate copies.

### Patch Changes

- Updated dependencies:
  - @sozai/otel@0.4.0

## 0.1.1

### Patch Changes

- Shutdown now takes a single reading of the grace deadline, shared by the shutdown hooks and the
  drain wait, so the drain can no longer be cut short while hooks still see time remaining. `listen()`
  no longer binds a socket when the server is disposed at the moment of binding, and plugin setup
  uses `toPromise` from `@sozai/async`.

## 0.1.0

### Minor Changes

- First release of `@sozai/http-server`: a plugin-based HTTP server on Hono for Node.js, so that HTTP
  services in the stack share one lifecycle and one plugin contract.

  `createServer(params)` runs every plugin's `setup` in dependency order and returns an `HTTPServer`;
  nothing is bound until `listen()`. The server is a `Disposer`: `close()`, a parent `signal`,
  `await using` or the opt-in `handleSignals()` (`SIGTERM`/`SIGINT`) start shutdown, and a setup
  failure, parent abort or bind failure rolls back by running the hooks registered so far.

  Plugins are built with `definePlugin` and typed names from `pluginName<Exports>()('scope:role')`.
  Each returns a single export that declared dependants read with `ctx.use(name)`; missing
  dependencies, duplicates and cycles throw a `PluginGraphError`. Routes, middleware, limits,
  readiness checks and hooks are registered during `setup` only, then assembled in a fixed order.
  `ctx.logger` is tagged with the plugin name.

  Client IPs come from `X-Forwarded-For` only through trusted proxies (`trustProxy`: off, a hop
  count, or IPs/CIDRs), with normalised addresses; `ctx.clientIP(c)`, `getClientIP` and
  `createTrustMatcher` expose it. Every request has a body size limit and a response deadline,
  overridable per path prefix. `/health/live` and `/health/ready` aggregate per-plugin readiness
  checks and report 503 once shutdown starts.

  Shutdown is graceful within one `graceMs` deadline: `onShutdown` hooks end streams while sockets
  are open, in-flight responses drain (connections are destroyed if the deadline expires), then
  `onClose` hooks release resources in reverse plugin order, each with its own timeout.
  `shutdownReport` records per-hook outcomes and whether the drain was forced.

  `hono` is a peer dependency.
