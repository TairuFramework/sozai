import type { Config, ConsoleSinkOptions, Logger, LogLevel } from '@logtape/logtape'
import {
  configureSync,
  getConfig,
  getConsoleSink,
  getLogger as logtape,
  resetSync,
} from '@logtape/logtape'

export type { Config, ConsoleSinkOptions, Logger, LogLevel }
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
    loggers: [
      { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: ['console'] },
      { category: ['sozai'], lowestLevel: 'error', sinks: ['console'] },
    ],
  }
}

/**
 * Configure logging, using the default configuration if none is given.
 *
 * The first call wins: if logging is already configured, this logs an error and
 * returns without reconfiguring, so that independent consumers each calling
 * `setup()` cannot crash the process. Use `reset()` to reconfigure deliberately.
 */
export function setup(maybeConfig?: Config<string, string>): void {
  if (getConfig() != null) {
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
 */
export function reset(): void {
  resetSync()
}
