# @sozai/http-server

Plugin-based HTTP server built on Hono. Node-only: it wraps `@hono/node-server` so that HTTP services in the stack share one lifecycle (setup order, health checks, graceful shutdown) and one plugin contract.

## Installation

```sh
pnpm add @sozai/http-server hono
```

`hono` is a peer dependency: plugins import its types and helpers (such as `HTTPException`) from the same copy the server uses.

## Example

```ts
import { createServer, definePlugin, pluginName } from '@sozai/http-server'

const greeter = pluginName<{ greet(name: string): string }>()('greeter')

const greeterPlugin = definePlugin({
  name: greeter,
  setup(ctx) {
    ctx.route('get', '/hello/:name', (c) => c.json({ message: `Hello, ${c.req.param('name')}` }))
    return { greet: (name: string) => `Hello, ${name}` }
  },
})

const server = await createServer({ plugins: [greeterPlugin], port: 3000 })
server.handleSignals()
await server.listen()
console.log(`Listening on ${server.url}`)
```

`createServer()` runs every plugin's `setup` in dependency order and returns an `HTTPServer`. Nothing is bound until `listen()` is called. `server.app` exposes the assembled Hono app (useful in tests, without listening). A request ID is generated per request (an incoming `X-Request-Id` is honoured only from a trusted proxy), exposed as `c.var.requestId` and echoed in the `X-Request-Id` response header.

Unhandled errors produce `{ "error": "Internal Server Error", "requestID": "..." }` with status 500, and unmatched routes produce `{ "error": "Not Found" }` with status 404.

## Plugins

A plugin has a `name`, an optional `dependsOn` list and a `setup(ctx)` function. Rules:

- **One export.** `setup` returns the plugin's single export (any value), typed through the name created by `pluginName<Exports>()('name')`. Dependants read it with `ctx.use(name)`, which is typed from their `dependsOn` list and only accepts declared dependencies.
- **`dependsOn`.** Plugins are set up in dependency order. Missing dependencies, duplicate names and cycles throw a `PluginGraphError` from `createServer`.
- **Registration phases.** Routes, middleware, limits, health checks and hooks (`ctx.route`, `ctx.middleware`, `ctx.limits`, `ctx.addReadinessCheck`, `ctx.onShutdown`, `ctx.onClose`) can only be registered during `setup`; the context is sealed once `setup` settles. Routes may not use the health paths.
- **`ctx.middleware(handler, path?)`.** Applies to every route, or, with a path, to a segment-aware prefix: `/api` covers `/api` and `/api/...`, not `/apix`.
- **`onShutdown` versus `onClose`.** `onShutdown` hooks run first, concurrently, as soon as shutdown starts, while sockets are still open: use them to end long-lived responses gracefully -- stop accepting new work on them, send final events or terminal frames, end streams. They must not release shared resources, since other plugins may still be serving requests. `onClose` hooks run last, serially in reverse plugin order, once in-flight responses have drained: use them to release resources (database pools, files). Each `onClose` hook has its own budget (`closeHookTimeoutMs`, or `opts.timeoutMs`).
- **Other context members.** `ctx.logger` (a child logger whose records carry a `plugin` property set to the plugin name), `ctx.tracer`, `ctx.signal` (the server-shutdown signal, aborted when the server is disposed), and `ctx.clientIP(c)` to resolve the client address with the server's proxy trust configuration.

A failing `setup` disposes the server, running the hooks registered so far, and `createServer` rejects with `Plugin "<name>" setup failed`, carrying the original error as `cause`.

## Proxy trust

`trustProxy` controls how the client IP is derived from `X-Forwarded-For`. It accepts three forms:

- `false` (default): the socket peer is the client; the header is ignored.
- A number `n`: trust `n` proxy hops; the client is the address `n` hops from the socket peer. When the chain (the socket peer plus the header entries) is shorter than `n + 1`, the left-most entry is returned.
- An array of IPs and CIDR ranges: trust those proxies; the client is the nearest address in the chain that is not a trusted proxy.

An invalid entry (or a negative or non-integer number) throws from `createServer`. A header containing any invalid IP is ignored entirely.

> **Warning:** hop-count trust assumes every request passes through exactly `n` proxies. A client that connects directly, or through fewer proxies, controls the entries the count lands on and can spoof its address. Deployments that allow direct connections must use the IP/CIDR form.

Addresses are normalised before matching and in the result: IPv6 is lowercased and compressed, and IPv4-mapped IPv6 (`::ffff:10.0.0.1` or `::ffff:a00:1`) becomes plain IPv4, so the resolved IP is stable enough to key rate limits on.

Plugins should use `ctx.clientIP(c)`. Outside plugins, `getClientIP(c, matcher)` takes a matcher compiled once with `createTrustMatcher(trustProxy)`.

## Limits

Every request is subject to a body size limit (default 1 MiB, `limits.bodyBytes`) and a request deadline (default 30 000 ms, `limits.requestTimeoutMs`). Plugins override either per path prefix with `ctx.limits(prefix, { bodyBytes, timeoutMs })`; `false` disables a limit. Prefixes are segment-aware, like `ctx.middleware`, and the longest matching prefix wins.

The deadline is built on `hono/timeout`: it is a **response deadline, not cancellation**. The client receives a 504 when it expires, but the handler keeps running unless it observes its own cancellation. For per-request cancellation use `c.req.raw.signal` (aborted when the client disconnects) with your own timeouts; `ctx.signal` is the server-shutdown signal, not a per-request one.

## Health

Two routes are registered: `/health/live` (always `200 { "status": "ok" }`) and `/health/ready`. Readiness aggregates the checks added with `ctx.addReadinessCheck(fn)`, reported per plugin: `200` when all pass, `503 { "status": "unavailable" }` otherwise. A check that throws, returns `false` or exceeds `health.checkTimeoutMs` (default 2000) fails; a timed-out check is abandoned, not cancelled. Once shutdown starts, readiness answers `503 { "status": "shutting-down" }` so load balancers stop routing. Paths are configurable with `health.livePath` and `health.readyPath`; `health.log` enables access logging for them (off by default).

## Shutdown

Call `server.close()`, abort the `signal` passed to `createServer`, or call `server.handleSignals()` to dispose on `SIGTERM`/`SIGINT` (it returns a function removing the listeners; both listeners are removed once either signal fires, so a second signal gets Node's default behaviour). `listen()` rejects with `Server is disposed` if disposal starts first, and with `Server is already listening` on a second call. Server `error` events after binding are logged, never thrown.

Sequence:

1. Readiness starts failing and the server stops accepting connections.
2. All `onShutdown` hooks run concurrently, bounded by the remaining grace time.
3. In-flight responses drain, up to `graceMs` (default 10 000 ms) in total. If it expires, the shutdown is marked forced. Either way, every remaining connection is then closed.
4. `onClose` hooks run serially, in reverse plugin order, each bounded by its timeout (default `closeHookTimeoutMs`, 5000 ms).

A hook that throws or times out is logged and does not stop the others. Afterwards, `server.shutdownReport` holds a `ShutdownReport`:

```ts
type ShutdownReport = {
  forced: boolean
  hooks: Array<{
    plugin: string
    phase: 'shutdown' | 'close'
    outcome: 'completed' | 'failed' | 'timed-out'
  }>
}
```

A timed-out hook is abandoned, not cancelled: it may still be running when the report is produced.
