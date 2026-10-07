import type { Logger } from '@sozai/log'

import type { HookOutcome, ShutdownReport } from './types.js'

export type ShutdownHookEntry = {
  plugin: string
  fn: () => void | Promise<void>
  timeoutMs: number
}

const TIMED_OUT = Symbol('timed-out')

async function runHook(
  hook: ShutdownHookEntry,
  phase: 'shutdown' | 'close',
  logger: Logger,
): Promise<HookOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), hook.timeoutMs)
  })
  const run = Promise.resolve().then(hook.fn)
  try {
    if ((await Promise.race([run, timeout])) === TIMED_OUT) {
      // The hook keeps running: there is no way to cancel it, only to stop waiting.
      run.catch((error: unknown) => {
        logger.error('Shutdown hook failed after timing out', {
          plugin: hook.plugin,
          phase,
          error,
        })
      })
      logger.warn('Shutdown hook timed out', {
        plugin: hook.plugin,
        phase,
        timeoutMs: hook.timeoutMs,
      })
      return 'timed-out'
    }
    return 'completed'
  } catch (error) {
    logger.error('Shutdown hook failed', { plugin: hook.plugin, phase, error })
    return 'failed'
  } finally {
    clearTimeout(timer)
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
