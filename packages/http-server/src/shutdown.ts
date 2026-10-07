import { raceSignal, ScheduledTimeout, toPromise } from '@sozai/async'
import type { Logger } from '@sozai/log'

import type { HookOutcome, ShutdownReport } from './types.js'

export type ShutdownHookEntry = {
  plugin: string
  fn: () => void | Promise<void>
  timeoutMs: number
}

async function runHook(
  hook: ShutdownHookEntry,
  phase: 'shutdown' | 'close',
  logger: Logger,
): Promise<HookOutcome> {
  const timeout = ScheduledTimeout.in(hook.timeoutMs)
  const run = toPromise(hook.fn)
  try {
    await raceSignal(run, timeout.signal)
    return 'completed'
  } catch (error) {
    // Only the timeout's own reason counts: a hook may reject with any error.
    if (timeout.signal.aborted && error === timeout.signal.reason) {
      // The hook keeps running: there is no way to cancel it, only to stop waiting.
      run.catch((lateError: unknown) => {
        logger.error('Shutdown hook failed after timing out', {
          plugin: hook.plugin,
          phase,
          error: lateError,
        })
      })
      logger.warn('Shutdown hook timed out', {
        plugin: hook.plugin,
        phase,
        timeoutMs: hook.timeoutMs,
      })
      return 'timed-out'
    }
    logger.error('Shutdown hook failed', { plugin: hook.plugin, phase, error })
    return 'failed'
  } finally {
    timeout.cancel()
  }
}

/**
 * Run shutdown hooks concurrently (`shutdown` phase) or serially in the given order
 * (`close` phase), each bounded by its own timeout.
 */
export async function runHooks(
  hooks: Array<ShutdownHookEntry>,
  mode: 'concurrent' | 'serial',
  logger: Logger,
): Promise<ShutdownReport['hooks']> {
  const phase = mode === 'concurrent' ? 'shutdown' : 'close'
  const run = async (hook: ShutdownHookEntry) => {
    return { plugin: hook.plugin, phase, outcome: await runHook(hook, phase, logger) } as const
  }
  if (mode === 'concurrent') {
    return await Promise.all(hooks.map(run))
  }
  const report: ShutdownReport['hooks'] = []
  for (const hook of hooks) {
    report.push(await run(hook))
  }
  return report
}
