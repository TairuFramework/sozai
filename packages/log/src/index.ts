import type { Config, ConsoleSinkOptions, Logger, LogLevel } from '@logtape/logtape'
import { configureSync, getConsoleSink, getLogger as logtape, resetSync } from '@logtape/logtape'

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

export function setup(maybeConfig?: Config<string, string>) {
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
