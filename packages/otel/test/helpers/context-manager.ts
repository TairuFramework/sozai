import { AsyncLocalStorage } from 'node:async_hooks'

import { type Context, context, ROOT_CONTEXT } from '@opentelemetry/api'
import { afterAll } from 'vitest'

// OTel's default NoopContextManager makes `context.with()` a pass-through and
// `context.active()` always return ROOT_CONTEXT, so activation never propagates and any
// test that relies on it passes vacuously. Registering one is a real SDK's job at startup,
// and nothing in this repo does it — hence this minimal stand-in over node:async_hooks.
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

  // Deliberately unimplemented — nothing here crosses an async boundary needing a bound
  // snapshot. A test that adds one (timer, emitter callback) must implement this, or it
  // will silently see the wrong active context.
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
 * Register a `TestContextManager` globally for the current test file. Call once, top level.
 *
 * Mutates OTel's process-global registry; safe only because vitest defaults to
 * `isolate: true` (fresh process per file) and this repo pins no config overriding that.
 */
export function useTestContextManager(): void {
  // A refusal must be loud: setGlobalContextManager returns false (and only diag.errors,
  // a no-op with no diag logger) if a manager is already registered, which would silently
  // fall back to NoopContextManager and make every activation test in this package vacuous.
  if (!context.setGlobalContextManager(new TestContextManager())) {
    throw new Error(
      'TestContextManager registration refused — a global ContextManager is already registered',
    )
  }

  afterAll(() => {
    context.disable()
  })
}
