import { AsyncLocalStorage } from 'node:async_hooks'

import { type Context, context, ROOT_CONTEXT } from '@opentelemetry/api'
import { afterAll } from 'vitest'

// `@opentelemetry/api`'s default NoopContextManager makes `context.with()` a
// pass-through and `context.active()` always return ROOT_CONTEXT — without a
// ContextManager registered, activation never actually propagates. No package
// in this repo registers one (that's a real SDK's job at startup), so tests
// that need `context.with`/`withActiveContext`/span activation to be
// observable need a minimal one. This uses Node's core `async_hooks` directly
// rather than pulling in an OTel SDK package or tracer/exporter.
export class TestContextManager {
  #storage = new AsyncLocalStorage<Context>()

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT
  }

  with<A extends Array<unknown>, F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(ctx, () => fn.apply(thisArg, args))
  }

  // Deliberately unimplemented: no test using this helper crosses an async
  // boundary that would need a context snapshot bound to it (e.g. an event
  // emitter callback or a timer), so a no-op pass-through is correct for
  // everything exercised today. If a future test adds such a boundary, this
  // must actually snapshot `ctx` and re-enter it when `target` runs, or that
  // test will silently see the wrong active context.
  bind<T>(_ctx: Context, target: T): T {
    return target
  }

  enable(): this {
    return this
  }

  disable(): this {
    return this
  }
}

/**
 * Register a `TestContextManager` as the global OTel ContextManager for the
 * current test file, and wire an `afterAll` to disable it again.
 *
 * This mutates OTel's process-global registry with no automatic teardown
 * beyond that `afterAll`, which is only safe because vitest defaults to
 * `isolate: true` (fresh process per test file) and this repo pins no vitest
 * config that overrides that. Call once at the top level of a test file.
 */
export function useTestContextManager(): void {
  // `setGlobalContextManager` returns `false` (and only `diag.error`s, which is
  // a no-op with no diag logger installed) if a manager is already registered.
  // A silently-refused registration would fall back to the default
  // `NoopContextManager`, making every activation-dependent test in this
  // package vacuous — so a refusal must be loud, not swallowed.
  if (!context.setGlobalContextManager(new TestContextManager())) {
    throw new Error(
      'TestContextManager registration refused — a global ContextManager is already registered',
    )
  }

  afterAll(() => {
    context.disable()
  })
}
