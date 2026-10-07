# `@sozai/http-server` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@sozai/http-server` -- a Hono app wrapped with a Node lifecycle, production middleware, health endpoints and a typed plugin contract.

**Architecture:** Plugins register routes, middleware, limits and hooks through a recording `PluginContext`; the core validates the plugin graph, runs `setup` serially in topological order, then assembles one root Hono app in fixed phases. `HTTPServer` extends `Disposer`; its dispose callback runs a notify → stop → drain → force → cleanup sequence against one deadline and records a `ShutdownReport`.

**Tech Stack:** TypeScript (ES2025, `@kigu/dev` presets), `hono` ^4.13.13, `@hono/node-server` ^2.1.3, `@hono/otel` ^1.2.0, `get-port` ^7.2.0, `@sozai/async`, `@sozai/log`, `@sozai/otel`, vitest.

**Spec:** `/Users/paul/dev/yulsi/kigu/docs/agents/plans/2026-10-07-teikyo-repo.md` (kigu branch `docs/teikyo-design`), section `@sozai/http-server`.

**Branch:** `feat/http-server` in sozai (already created).

## Global Constraints

- Package `packages/http-server`, name `@sozai/http-server`, version `0.1.0`, `"engines": { "node": ">=24" }`, MIT, `publishConfig.access: public`; copy script/exports layout from `packages/otel/package.json`.
- Add to `pnpm-workspace.yaml` catalog: `hono: ^4.13.13`, `'@hono/node-server': ^2.1.3`, `'@hono/otel': ^1.2.0`, `get-port: ^7.2.0`. Dependencies use `catalog:`; sozai deps use `workspace:^`.
- Conventions (`kigu:conventions`): `type` not `interface`; `Array<T>`; `#private` fields, no `readonly`/`private`/`protected` modifiers -- expose getters; class constructor takes one `XParams` object; `ID`/`HTTP`/`IP` casing; `.js` import suffixes; tests in `packages/http-server/test/*.test.ts`; no plan or task references in code, comments or test names.
- Defaults pinned by the spec: `port` omitted → `getPort({ port: 3000 })`; `trustProxy` default `false`; `graceMs` default `10_000`; `closeHookTimeoutMs` default `5_000`; `health.checkTimeoutMs` default `2000`; health paths `/health/live` and `/health/ready`.
- Error envelope: non-`HTTPException` errors → status 500, body `{ "error": "Internal Server Error", "requestID": "<id>" }`, stack logged only. `notFound` → 404 `{ "error": "Not Found" }`. Both owned by the root app.
- Request ID is exposed as `c.var.requestId` (Hono's built-in variable name) and the `X-Request-Id` response header.
- Run commands from `packages/http-server` with `pnpm exec vitest run <file>` and `pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`. Use `rtk proxy pnpm run <script>` for repo scripts.

## Review Focus

- **Plugin throws inside a route handler after the response started streaming** -- the request must still be counted until the `ServerResponse` closes, and drain must not hang past the deadline. Test owned by Task 7.
- **`dispose()` called twice, or during `listen()`** -- second call returns the same `disposed` promise; a `listen()` racing dispose rejects without binding a leaked socket. Test owned by Task 7.
- **IPv6 hostnames** (`hostname: '::1'`) -- `url` must bracket the address (`http://[::1]:<port>`). Test owned by Task 7.
- **Plugin route path equal to a health path with a trailing slash** (`/health/ready/`) -- treated as a collision; Hono's default strict routing would otherwise let it slip. Test owned by Task 5.
- **A readiness check that throws synchronously** -- counts as failing, does not 500 the readiness route. Test owned by Task 6.

---

### Task 1: Package scaffold, plugin types, `pluginName`, `definePlugin`

**Files:**
- Create: `packages/http-server/package.json`, `tsconfig.json`, `tsconfig.test.json`, `README.md`, `LICENSE` (copy from `packages/otel`)
- Create: `packages/http-server/src/types.ts`, `src/plugin.ts`, `src/index.ts`
- Modify: `pnpm-workspace.yaml` (catalog entries above)
- Test: `packages/http-server/test/types.test.ts`

**Interfaces:**
- Produces (`src/types.ts`, all exported from `src/index.ts`):

```ts
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
```

(`readonly` on the phantom `__exports` property and on tuple types is a type-level device, not a class modifier, so it is allowed.)
- Produces (`src/plugin.ts`): `pluginName<Exports>(): <Name extends string>(name: Name) => PluginName<Name, Exports>` (returns the string unchanged) and `definePlugin<Name extends string, Exports, const Deps extends ReadonlyArray<AnyPluginName> = []>(plugin: { name: PluginName<Name, Exports> | Name; dependsOn?: Deps; setup(ctx: PluginContext<Deps>): Exports | Promise<Exports> }): HTTPPlugin<Name, Exports, Deps>` (fills `dependsOn` with `[]` when omitted).

- [ ] **Step 1: Write the type fixture test** `test/types.test.ts`:

```ts
import { describe, expect, expectTypeOf, test } from 'vitest'

import { type AnyHTTPPlugin, definePlugin, pluginName } from '../src/index.js'

const DB = pluginName<{ query(): number }>()('test:db')
const CACHE = pluginName<Map<string, string>>()('test:cache')

describe('plugin typing', () => {
  test('setup return type becomes the export type', () => {
    const plugin = definePlugin({ name: DB, setup: () => ({ query: () => 1 }) })
    expectTypeOf(plugin.name).toEqualTypeOf<typeof DB>()
    expect(plugin.dependsOn).toEqual([])
  })

  test('use accepts declared dependencies only', () => {
    definePlugin({
      name: 'test:consumer',
      dependsOn: [DB],
      setup(ctx) {
        expectTypeOf(ctx.use(DB)).toEqualTypeOf<{ query(): number }>()
        // @ts-expect-error CACHE is not declared in dependsOn
        ctx.use(CACHE)
      },
    })
  })

  test('typed plugins are assignable to AnyHTTPPlugin', () => {
    const plugin = definePlugin({ name: DB, setup: () => ({ query: () => 1 }) })
    expectTypeOf(plugin).toMatchTypeOf<AnyHTTPPlugin>()
  })
})
```

- [ ] **Step 2: Run** `pnpm install` at the repo root, then `pnpm exec vitest run test/types.test.ts` -- expect FAIL (module not found).
- [ ] **Step 3: Implement** the scaffold, `src/types.ts` and `src/plugin.ts` per Interfaces. Import `Context`, `Handler`, `MiddlewareHandler` from `hono`, `Logger` from `@sozai/log`, `Tracer` from `@sozai/otel` (all `import type`).
- [ ] **Step 4: Run** `pnpm exec vitest run test/types.test.ts` and `pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json` -- expect PASS and no type errors (the `@ts-expect-error` line must be consumed).
- [ ] **Step 5: Commit** -- `git add packages/http-server pnpm-workspace.yaml pnpm-lock.yaml && git commit -m "feat(http-server): add package with plugin contract types"`

### Task 2: Plugin graph validation and ordering

**Files:**
- Create: `packages/http-server/src/graph.ts`
- Test: `packages/http-server/test/graph.test.ts`

**Interfaces:**
- Consumes: `AnyHTTPPlugin` (Task 1).
- Produces: `class PluginGraphError extends Error` (exported) with getter `plugin: string`; `sortPlugins(plugins: Array<AnyHTTPPlugin>): Array<AnyHTTPPlugin>` -- validates then returns topological order, ties keeping input order.

- [ ] **Step 1: Write failing tests** in `test/graph.test.ts`, each building plain `AnyHTTPPlugin` objects with a no-op `setup`:
  - `test('orders dependencies first, keeping list order for ties')`: input `[c(dependsOn: a), a, b]` → names `['a', 'c', 'b']`.
  - `test('rejects duplicate names')`: `[a, a]` → throws `PluginGraphError`, `plugin === 'a'`, message contains `duplicate`.
  - `test('rejects missing dependencies')`: `[b(dependsOn: x)]` → `plugin === 'b'`, message contains `'x'`.
  - `test('rejects cycles')`: `[a(dependsOn: b), b(dependsOn: a)]` → message contains `cycle` and both names.
- [ ] **Step 2: Run** `pnpm exec vitest run test/graph.test.ts` -- expect FAIL.
- [ ] **Step 3: Implement** `sortPlugins` in `src/graph.ts`: validation pass (names, presence) before ordering; ordering by repeated stable selection of the first plugin whose dependencies are all placed (O(n²) is fine); leftover plugins form the cycle. Export `PluginGraphError` from `src/index.ts`.
- [ ] **Step 4: Run** the test -- expect PASS.
- [ ] **Step 5: Commit** -- `git commit -am "feat(http-server): validate and order the plugin graph"` (add new files first).

### Task 3: Client IP resolver

**Files:**
- Create: `packages/http-server/src/client-ip.ts`
- Test: `packages/http-server/test/client-ip.test.ts`

**Interfaces:**
- Consumes: `TrustProxy` (Task 1).
- Produces: `resolveClientIP(params: { peer: string; forwardedFor: string | undefined; trustProxy: TrustProxy }): string` (pure, exported) and `isTrustedPeer(peer: string, trustProxy: TrustProxy): boolean`. Task 5 wires `getClientIP(c)` on top using `getConnInfo` from `@hono/node-server/conninfo`.

Algorithm (from the spec, not determined by tests alone):

```
normalize(a) = strip IPv4-mapped prefix "::ffff:" when followed by dotted IPv4; lowercase IPv6
entries = forwardedFor split on ",", trimmed; if any entry is not a valid IP (node:net isIP) → return normalize(peer)
chain = [normalize(peer), ...reverse(entries).map(normalize)]
false      → chain[0]
n: number  → chain[min(n, chain.length - 1)]
cidrs      → first chain entry not matching any CIDR; if all match, last entry
```

CIDR matching uses `node:net` `BlockList` (`addSubnet` / `addAddress`, family from `isIP`). A bare IP in the list means a single address.

- [ ] **Step 1: Write failing tests** (`describe('resolveClientIP')`), one `test` per row, asserting the return value:

| test name | peer | forwardedFor | trustProxy | expected |
|---|---|---|---|---|
| ignores headers when trust is off | `10.0.0.1` | `1.2.3.4` | `false` | `10.0.0.1` |
| one hop returns the rightmost entry | `10.0.0.1` | `6.6.6.6, 1.2.3.4` | `1` | `1.2.3.4` |
| two hops skip one forwarded proxy | `10.0.0.1` | `1.2.3.4, 10.0.0.2` | `2` | `1.2.3.4` |
| short chain returns the last entry | `10.0.0.1` | `undefined` | `2` | `10.0.0.1` |
| cidr trust skips trusted proxies | `10.0.0.1` | `6.6.6.6, 1.2.3.4, 10.0.0.2` | `['10.0.0.0/8']` | `1.2.3.4` |
| cidr trust ignores spoofed left entries | `10.0.0.1` | `6.6.6.6, 1.2.3.4` | `['10.0.0.0/8']` | `1.2.3.4` |
| untrusted peer ignores headers under cidr trust | `8.8.8.8` | `1.2.3.4` | `['10.0.0.0/8']` | `8.8.8.8` |
| malformed entry falls back to the peer | `10.0.0.1` | `1.2.3.4, not-an-ip` | `1` | `10.0.0.1` |
| normalizes ipv4-mapped ipv6 | `::ffff:10.0.0.1` | `undefined` | `false` | `10.0.0.1` |
| matches ipv6 cidr | `fd00::1` | `2001:db8::5` | `['fd00::/8']` | `2001:db8::5` |

  Plus `test('isTrustedPeer')`: `isTrustedPeer('10.0.0.1', ['10.0.0.0/8']) === true`, `isTrustedPeer('8.8.8.8', ['10.0.0.0/8']) === false`, `isTrustedPeer('8.8.8.8', 1) === true`, `isTrustedPeer('8.8.8.8', false) === false`.
- [ ] **Step 2: Run** `pnpm exec vitest run test/client-ip.test.ts` -- expect FAIL.
- [ ] **Step 3: Implement** per the algorithm above.
- [ ] **Step 4: Run** -- expect PASS.
- [ ] **Step 5: Commit** -- `git commit -m "feat(http-server): resolve client IPs behind trusted proxies"`

### Task 4: Per-path limits

**Files:**
- Create: `packages/http-server/src/limits.ts`
- Test: `packages/http-server/test/limits.test.ts`

**Interfaces:**
- Consumes: `Limits` (Task 1).
- Produces: `class LimitsTable` with constructor `LimitsTableParams = { defaults: { bodyBytes: number | false; timeoutMs: number | false } }`, methods `set(pathPrefix: string, overrides: Limits): void` and `resolve(path: string): { bodyBytes: number | false; timeoutMs: number | false }`; and `createLimitsMiddleware(table: LimitsTable): MiddlewareHandler` which applies `hono/body-limit` (`maxSize`) and `hono/timeout` with the resolved values, caching one Hono middleware instance per distinct value.

Prefix matching is segment-aware: `/rpc` matches `/rpc` and `/rpc/x`, not `/rpcx`. The longest matching prefix wins; fields absent from an override inherit from the next shorter match, then the defaults.

- [ ] **Step 1: Write failing tests** in `test/limits.test.ts`:
  - `test('resolves defaults when nothing matches')`: defaults `{ bodyBytes: 100, timeoutMs: 50 }`, `resolve('/x')` deep-equals the defaults.
  - `test('longest prefix wins and missing fields inherit')`: `set('/rpc', { bodyBytes: false })`, `set('/rpc/admin', { timeoutMs: 10 })`; `resolve('/rpc/admin/y')` → `{ bodyBytes: false, timeoutMs: 10 }`; `resolve('/rpcx')` → defaults.
  - `test('middleware rejects oversized bodies with 413')`: a Hono app using `createLimitsMiddleware` with `bodyBytes: 4`, `app.post('/', c => c.text('ok'))`; `app.request('/', { method: 'POST', body: '12345' })` → status `413`.
  - `test('middleware skips the body limit when disabled for the path')`: `set('/big', { bodyBytes: false })`; posting 10 bytes to `/big` → `200`.
  - `test('middleware applies the response deadline')`: `timeoutMs: 20`, handler awaits 100 ms → status `504`.
- [ ] **Step 2: Run** `pnpm exec vitest run test/limits.test.ts` -- expect FAIL.
- [ ] **Step 3: Implement** `src/limits.ts`.
- [ ] **Step 4: Run** -- expect PASS.
- [ ] **Step 5: Commit** -- `git commit -m "feat(http-server): add per-path body and timeout limits"`

### Task 5: Plugin registrar and app assembly

**Files:**
- Create: `packages/http-server/src/registrar.ts`, `src/middleware.ts`, `src/app.ts`
- Test: `packages/http-server/test/app.test.ts`

**Interfaces:**
- Consumes: `sortPlugins` (Task 2), `resolveClientIP`/`isTrustedPeer` (Task 3), `LimitsTable`/`createLimitsMiddleware` (Task 4).
- Produces:
  - `src/registrar.ts`: `class PluginRegistrar` -- one per plugin, constructor `PluginRegistrarParams = { plugin: string; logger: Logger; tracer: Tracer; signal: AbortSignal; exports: Map<string, unknown>; dependsOn: ReadonlyArray<string>; limits: LimitsTable; reservedPaths: ReadonlyArray<string>; trustProxy: TrustProxy }`. Getter `context: PluginContext<ReadonlyArray<AnyPluginName>>`. Getters `routes`, `middleware`, `readinessChecks`, `shutdownHooks`, `closeHooks` (arrays of recorded registrations). Method `seal(): void` -- later registration calls throw `Error('Plugin "<name>" registered after setup')`. `use(name)` throws `Error('Plugin "<plugin>" did not declare dependency "<name>"')` for undeclared names.
  - `src/middleware.ts`: `requestIDMiddleware(trustProxy: TrustProxy): MiddlewareHandler` (honours a valid incoming `X-Request-Id` -- 1 to 255 chars of `[\w\-]` -- only from a trusted peer, else `crypto.randomUUID()`; sets `c.var.requestId` and the response header), `accessLogMiddleware(logger: Logger): MiddlewareHandler` (`logger.info('HTTP request', { method, path, status, durationMs, requestID })`), `getClientIP(c: Context, trustProxy: TrustProxy): string` (peer from `getConnInfo(c).remote.address`, header `X-Forwarded-For`), `errorHandler(logger: Logger): ErrorHandler`, `notFoundHandler: NotFoundHandler`.
  - `src/app.ts`: `assembleApp(params: { registrars: Array<PluginRegistrar>; health: HealthRoutes; trustProxy: TrustProxy; limits: LimitsTable; logger: Logger; tracer: Tracer }): Hono` with phases: (1) `requestIDMiddleware`, `@hono/otel` `httpInstrumentationMiddleware({ tracer })`, `secureHeaders()`, `accessLogMiddleware` (skipped for health paths unless `health.log`), `createLimitsMiddleware`; (2) health routes via `health.register(app)`; (3) every registrar's middleware in order; (4) every registrar's routes in order; `onError` and `notFound` on the root. `HealthRoutes` is defined in Task 6; until then pass a stub `{ paths: [], register() {} }` in tests.

Registration rejects a plugin route whose path, with one trailing `/` removed, equals a reserved health path: `Error('Plugin "<name>" route "<path>" collides with a reserved health path')`.

- [ ] **Step 1: Write failing tests** in `test/app.test.ts` using `app.request(...)` (no socket). Build registrars directly, call a plugin-style function against `registrar.context`, `seal()`, then `assembleApp`:
  - `test('middleware from a later plugin applies to routes of an earlier plugin')`: plugin A registers `route('get', '/a', c => c.text('a'))`; plugin B registers `middleware((c) => c.text('blocked', 429))`; `GET /a` → `429`.
  - `test('route-scoped middleware does not gate sibling routes')`: A registers `route('get', '/a', guard, handler)` where `guard` returns 401; B registers `route('get', '/b', handler)`; `GET /a` → `401`, `GET /b` → `200`.
  - `test('registration after setup throws')`: after `seal()`, `context.route(...)` throws with message containing `after setup`.
  - `test('use rejects undeclared dependencies')`: registrar with `dependsOn: ['x']`, exports map has `x` and `y`; `use('x')` returns the value, `use('y')` throws containing `did not declare dependency "y"`.
  - `test('routes colliding with health paths are rejected')`: reserved `['/health/ready']`; `route('get', '/health/ready/', h)` throws containing `reserved health path`.
  - `test('errors use the core envelope')`: route throws `new Error('boom')` → status `500`, JSON `{ error: 'Internal Server Error', requestID: <response X-Request-Id header> }`, body does not contain `boom`.
  - `test('HTTPException passes through')`: route throws `new HTTPException(418, { message: 'tea' })` → status `418`.
  - `test('unknown paths return the core 404')`: `GET /nope` → `404`, JSON `{ error: 'Not Found' }`.
  - `test('incoming request IDs are honoured only from trusted peers')`: request with `X-Request-Id: abc`; with `trustProxy: false` the response header is not `abc`; with `trustProxy: 1` it is `abc`. Supply the peer via `app.request(url, init, { incoming: { socket: { remoteAddress: '10.0.0.1' } } })` (the env shape `getConnInfo` reads).
- [ ] **Step 2: Run** `pnpm exec vitest run test/app.test.ts` -- expect FAIL.
- [ ] **Step 3: Implement** `src/registrar.ts`, `src/middleware.ts`, `src/app.ts`.
- [ ] **Step 4: Run** -- expect PASS.
- [ ] **Step 5: Commit** -- `git commit -m "feat(http-server): assemble plugin routes and middleware in phases"`

### Task 6: Health routes and readiness

**Files:**
- Create: `packages/http-server/src/health.ts`
- Modify: `packages/http-server/src/app.ts` (replace the stub type with `HealthRoutes`)
- Test: `packages/http-server/test/health.test.ts`

**Interfaces:**
- Produces: `class HealthRoutes`, constructor `HealthRoutesParams = { livePath?: string; readyPath?: string; checkTimeoutMs?: number; log?: boolean; isShuttingDown: () => boolean }`; getter `paths: Array<string>`; `addCheck(plugin: string, check: () => boolean | Promise<boolean>): void`; `register(app: Hono): void`.
- Ready response: `200 { status: 'ok', checks: Record<string, boolean> }` or `503 { status: 'unavailable', checks }`. A plugin's entry is `true` only if all its checks pass. While `isShuttingDown()` returns true, respond `503 { status: 'shutting-down', checks: {} }` without running checks.

- [ ] **Step 1: Write failing tests** (Hono `app.request`):
  - `test('live returns 200')`.
  - `test('ready aggregates checks per plugin')`: plugin `a` two checks (`true`, `true`), plugin `b` one check `false` → `503`, `checks` deep-equals `{ a: true, b: false }`.
  - `test('a throwing check counts as failing')`: check throws synchronously → `503`, `checks.a === false`.
  - `test('a slow check times out')`: `checkTimeoutMs: 20`, check resolves after 100 ms → `503`.
  - `test('ready reports shutting-down')`: `isShuttingDown: () => true` → `503`, `status === 'shutting-down'`.
  - `test('plugin catch-all routes do not shadow health')`: via `assembleApp`, a plugin registers `route('all', '*', c => c.text('x'))` and `middleware(c => c.text('limited', 429))`; `GET /health/live` → `200`.
- [ ] **Step 2: Run** `pnpm exec vitest run test/health.test.ts` -- expect FAIL.
- [ ] **Step 3: Implement** `src/health.ts`; run each check through `Promise.race` against the timeout, wrapping sync throws.
- [ ] **Step 4: Run** `pnpm exec vitest run test/health.test.ts test/app.test.ts` -- expect PASS.
- [ ] **Step 5: Commit** -- `git commit -m "feat(http-server): add liveness and readiness routes"`

### Task 7: `createServer`, `HTTPServer` lifecycle and shutdown

**Files:**
- Create: `packages/http-server/src/server.ts`, `src/shutdown.ts`
- Modify: `packages/http-server/src/index.ts`
- Test: `packages/http-server/test/server.test.ts`, `test/shutdown.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
export type CreateServerParams = {
  plugins?: Array<AnyHTTPPlugin>
  port?: number | GetPortOptions        // GetPortOptions = get-port `Options`
  hostname?: string
  trustProxy?: TrustProxy
  limits?: { bodyBytes?: number; requestTimeoutMs?: number }
  health?: { livePath?: string; readyPath?: string; checkTimeoutMs?: number; log?: boolean }
  graceMs?: number
  closeHookTimeoutMs?: number
  logger?: Logger                       // default getSozaiLogger('http-server')
  tracer?: Tracer                       // default createTracerFactory('sozai')('http-server')
  signal?: AbortSignal
}
export declare function createServer(params?: CreateServerParams): Promise<HTTPServer>
export declare class HTTPServer extends Disposer {
  get app(): Hono
  get url(): string                     // throws Error('Server is not listening') before listen()
  get shutdownReport(): ShutdownReport | undefined
  listen(): Promise<void>
  close(reason?: unknown): Promise<void>
  handleSignals(): () => void
}
```

  `src/shutdown.ts`: `runHooks(hooks: Array<{ plugin: string; fn: () => void | Promise<void>; timeoutMs: number }>, mode: 'concurrent' | 'serial', logger: Logger): Promise<ShutdownReport['hooks']>` -- each hook bounded by its timeout; a timed-out hook is left running and logged; rejections logged.
- Default request limits when `limits` is omitted: `bodyBytes: 1_048_576`, `requestTimeoutMs: 30_000`.

Lifecycle decisions the tests pin:
- `HTTPServer` passes `{ dispose: (reason) => this.#shutdown(reason), signal: params.signal }` to `Disposer`.
- `createServer` constructs the server, then runs `setup` serially in `sortPlugins` order, storing each plugin's return value in the exports map. Before each `setup` it checks `signal.aborted` and stops. The shutdown callback first awaits the in-progress setup promise (if any), so late registrations are collected. On any setup failure: `await server.dispose(error)`, then rethrow the setup error. On parent abort: reject with the abort reason after disposal completes.
- `listen()` uses `createAdaptorServer({ fetch: app.fetch })` from `@hono/node-server` and `server.listen(port, hostname)`. It tracks every `ServerResponse` from the server `'request'` event in a `Set`, removing it on `'close'`. On bind error it runs `dispose(error)` then rejects. `listen()` after disposal began rejects with `Error('Server is disposed')`.
- Shutdown order: readiness flips (the `isShuttingDown` flag set at the top of `#shutdown`) → `server.close()` (do not await) → arm deadline `graceMs` → run all `onShutdown` hooks concurrently (each bounded by the remaining deadline) → wait until the tracked response set is empty or the deadline passes → on deadline, `closeAllConnections()` and set `forced: true` → run `onClose` hooks serially in reverse topological order (per-hook `timeoutMs` override, else `closeHookTimeoutMs`) → store the report.
- `handleSignals()` registers `process.once` for `SIGTERM` and `SIGINT` calling `dispose()`; returns a function removing both.

- [ ] **Step 1: Write failing tests** in `test/server.test.ts` (real sockets; port from `getPort()`; `fetch` against `server.url`):
  - `test('listens on the requested port and serves plugin routes')`: `url` equals `http://localhost:<port>`; plugin `GET /hello` → `200` `'hi'`.
  - `test('brackets IPv6 hosts in url')`: `hostname: '::1'` → `url` starts with `http://[::1]:`.
  - `test('url throws before listen')`.
  - `test('bind failure disposes and rejects')`: two servers on the same numeric port; second `listen()` rejects with `EADDRINUSE`; a close hook registered by its plugin ran.
  - `test('setup failure runs the failing plugin hooks and rejects')`: plugin registers `onClose(spy)` then throws `Error('nope')`; `createServer` rejects with `nope`; `spy` called once.
  - `test('parent abort during setup waits for the running setup')`: plugin A's setup awaits a deferred and registers `onClose(spyA)` after it resolves; plugin B (later) has `setup` spy; abort the parent signal while A is pending, then resolve A; `createServer` rejects; `spyA` called; B's setup never called.
  - `test('dispose twice returns the same promise')`.
  - `test('await using disposes')`: in an inner block `await using server = await createServer(...)` with a close spy; after the block the spy was called.
  - `test('readiness reports 503 once shutdown begins')`: a plugin `onShutdown` hook calls `server.app.request('/health/ready')` and records the status; after `dispose()` the recorded status is `503`.
- [ ] **Step 2: Write failing tests** in `test/shutdown.test.ts`:
  - `test('onShutdown delivers a final stream event before sockets close')`: plugin route uses `streamSSE` and keeps the stream open until `ctx.signal` aborts; its `onShutdown` writes event `data: bye` and closes the stream. Client reads the SSE body; call `server.dispose()`; client text ends with `data: bye`; report `forced === false`.
  - `test('drain waits for in-flight responses')`: route responds after 100 ms; start the request, then `dispose()`; response status `200`; `disposed` resolves after the response.
  - `test('drain deadline forces sockets closed')`: `graceMs: 50`, route never ends its stream and has no `onShutdown`; `dispose()` resolves within 1 s; report `forced === true`.
  - `test('a route that throws after streaming started is counted until close')`: `streamSSE` callback writes once then throws; `dispose()` resolves within `graceMs` and the report is set.
  - `test('close hooks run in reverse dependency order')`: plugins `db` and `app (dependsOn db)` push names to an array in `onClose` → `['app', 'db']`.
  - `test('a timed-out close hook is reported and later hooks still run')`: `closeHookTimeoutMs: 20`, `app`'s hook never resolves → report has `{ plugin: 'app', phase: 'close', outcome: 'timed-out' }`, `db`'s hook ran with `outcome: 'completed'`.
  - `test('a close hook can extend its own budget')`: `onClose(fn, { timeoutMs: 200 })` where `fn` takes 50 ms with `closeHookTimeoutMs: 20` → outcome `completed`.
  - `test('handleSignals disposes on SIGTERM')`: `process.emit('SIGTERM')` → `disposed` resolves; the returned unsubscribe removes listeners (`process.listenerCount('SIGTERM')` back to its prior value).
- [ ] **Step 3: Run** `pnpm exec vitest run test/server.test.ts test/shutdown.test.ts` -- expect FAIL.
- [ ] **Step 4: Implement** `src/shutdown.ts`, `src/server.ts`; export `createServer`, `HTTPServer`, `CreateServerParams`, `getClientIP`, `resolveClientIP` and all types from `src/index.ts`.
- [ ] **Step 5: Run** `pnpm exec vitest run` and `pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json` -- expect all PASS.
- [ ] **Step 6: Commit** -- `git commit -m "feat(http-server): add server lifecycle with graceful shutdown"`

### Task 8: Docs, versioning intent, full verification

**Files:**
- Modify: `packages/http-server/README.md`, `docs/agents/architecture.md`
- Create: `.changeset/` intent via `pnpm change`

- [ ] **Step 1:** Write `README.md`: install line; a 20-line example with `definePlugin`, `pluginName`, `createServer`, `listen()`, `handleSignals()`; sections *Plugins* (rules: one export, `dependsOn`, registration phases, `onShutdown` vs `onClose`), *Proxy trust* (the three `trustProxy` forms; WARNING that proxies must overwrite client-supplied `X-Forwarded-For`, or hop-count trust is spoofable on direct connections), *Limits* (`ctx.limits`; `hono/timeout` is a response deadline, not cancellation), *Health*, *Shutdown* (sequence and `ShutdownReport`). British spelling, ` -- ` dashes.
- [ ] **Step 2:** In `docs/agents/architecture.md`, add `http-server` to the package list and a paragraph: Node-only like `lock`; it wraps Hono so stack HTTP services share one lifecycle and plugin contract.
- [ ] **Step 3:** Run `pnpm change` and record a minor intent for `@sozai/http-server` ("Add HTTP server with plugin contract").
- [ ] **Step 4:** Run `rtk proxy pnpm run build`, `rtk proxy pnpm run test` and `pnpm exec biome check .` at the repo root -- expect success with no diagnostics.
- [ ] **Step 5: Commit** -- `git add -A && git commit -m "docs(http-server): document plugins, proxy trust and shutdown"`
