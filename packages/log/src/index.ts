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

/** An error report that always lands somewhere. `error` is optional: not every condition has one. */
export type Reporter = (message: string, error?: unknown) => void

/**
 * Build a reporter for conditions a host may have wired no handler for, where the alternative to
 * reporting is silence.
 *
 * Records go to the logger for `category`. When logging has not been configured AT ALL, logtape
 * drops everything, so they go to the console tagged with `packageName` instead — the genuine last
 * resort, not an approximation of one: {@link getDefaultConfig} carries every category, so a
 * configured app that still sees nothing narrowed the category deliberately.
 *
 * `error` level only, on purpose. `warn` would be dropped by the default config.
 */
export function getReporter(
  category: string | Array<string> | ReadonlyArray<string>,
  packageName: string,
): Reporter {
  const logger = getLogger(category)
  return (message, error) => {
    if (isSetup()) {
      logger.error(message, error === undefined ? undefined : { error })
      return
    }
    if (error === undefined) {
      console.error(`[${packageName}] ${message}`)
      return
    }
    console.error(`[${packageName}] ${message}`, error)
  }
}

export function getDefaultConfig(options?: ConsoleSinkOptions): Config<'console', never> {
  return {
    sinks: { console: getConsoleSink(options) },
    // Any category reaches the console at error unless an app deliberately narrows it. Without
    // this, a package logging under its own category is dropped by the very config that made
    // isSetup() answer true — the app took the documented easy path and went deaf.
    //
    // The root entry replaces the ['sozai'] entry it used to sit beside, on purpose.
    // `parentSinks` defaults to 'inherit', which UNIONS a category's own sinks with its parent's
    // rather than overriding them, and does not de-duplicate by sink identity: a second entry
    // naming 'console' would print every record under it twice, through the same sink object.
    //
    // The meta entry names no sink for exactly that reason — it inherits the root's console and
    // prints once. It is not redundant with the root entry: logtape reads a `category: []` entry
    // as configuring the meta logger (so its "configure the meta logger with a separate sink"
    // notice stays suppressed either way), but that leaves the meta logger's OWN `lowestLevel` at
    // 'trace', with only the root's dispatch plan holding its info-level records back. A consumer
    // that takes this config and lowers the root — the documented way to turn up logging — would
    // then get logtape's internal chatter as well. Pinning the meta logger here makes 'error' its
    // own floor, so it stays quiet whatever the root is set to.
    loggers: [
      { category: [], lowestLevel: 'error', sinks: ['console'] },
      { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: [] },
    ],
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
