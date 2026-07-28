import type { Config, ConsoleSinkOptions, Logger, LogLevel, LogRecord } from '@logtape/logtape'
import {
  configureSync,
  getConfig,
  getConsoleSink,
  getLogger as logtape,
  resetSync,
} from '@logtape/logtape'

export type { Config, ConsoleSinkOptions, Logger, LogLevel, LogRecord }
export { getConsoleSink }

export function getLogger(
  name: string | Array<string> | ReadonlyArray<string>,
  properties?: Record<string, unknown>,
): Logger {
  const logger = logtape(name)
  return properties ? logger.with(properties) : logger
}

export function getSozaiLogger(namespace: string, properties?: Record<string, unknown>): Logger {
  return getLogger(['sozai', namespace], properties)
}

export function getDefaultConfig(options?: ConsoleSinkOptions): Config<'console', never> {
  return {
    sinks: { console: getConsoleSink(options) },
    // Any category reaches the console at error unless an app deliberately narrows it. Without
    // this, a package logging under its own category is dropped by the very config that made
    // isSetup() answer true — the app took the documented easy path and went deaf.
    //
    // One entry, and the ['logtape','meta'] and ['sozai'] entries it replaces are gone on purpose.
    // `parentSinks` defaults to 'inherit', which UNIONS a category's own sinks with its parent's
    // rather than overriding them, and does not de-duplicate by sink identity: keeping either
    // alongside this would print every record under it twice, through the same sink object. The
    // root entry covers both at the same level, and logtape counts a `category: []` entry as
    // configuring the meta logger, so its "not configured" fallback stays suppressed.
    loggers: [{ category: [], lowestLevel: 'error', sinks: ['console'] }],
  }
}

/**
 * Configure logging, using the default configuration if none is given.
 *
 * The first call wins: if logging is already configured, this logs an error and
 * returns without reconfiguring, so that independent consumers each calling
 * `setup()` cannot crash the process. Use `reset()` to reconfigure deliberately.
 *
 * `reset: true` on the given config is not honoured once logging is already
 * configured: the guard returns before `configureSync` ever sees it, so the
 * option is silently swallowed on a second call. Call `reset()` then
 * `setup(config)` instead.
 */
export function setup(maybeConfig?: Config<string, string>): void {
  if (isSetup()) {
    getSozaiLogger('log').error('Logging already configured, setup() call ignored')
    return
  }
  configureSync(maybeConfig ?? getDefaultConfig())
}

/**
 * Clear the logging configuration, so `setup()` can configure it again.
 *
 * Both an escape hatch for intentional reconfiguration and the way test suites
 * clear logtape's process-global state between cases.
 *
 * Wraps logtape's synchronous `resetSync()`, so it does not dispose async sinks.
 * That is only reachable by a consumer who bypassed `setup()` and configured
 * logtape directly with its async `configure`: `setup()` wraps `configureSync`,
 * which throws on async sinks, so nothing configured through this package can
 * hit it.
 */
export function reset(): void {
  resetSync()
}

/**
 * Whether logging has been configured, via `setup()` or otherwise.
 */
export function isSetup(): boolean {
  return getConfig() != null
}
