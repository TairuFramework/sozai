import { toPromise } from './utils.js'

/** A step that may return a value or thenable, or throw synchronously. */
export type SettlementStep = () => unknown | PromiseLike<unknown>

function flattenError(error: unknown): Array<unknown> {
  return error instanceof AggregateError ? error.errors.flatMap(flattenError) : [error]
}

function throwFailures(results: Array<PromiseSettledResult<unknown>>, message: string): void {
  const failures = results.filter((result) => result.status === 'rejected')
  if (failures.length !== 0) {
    throw new AggregateError(
      failures.flatMap((result) => flattenError(result.reason)),
      message,
    )
  }
}

/**
 * Run all steps concurrently and wait for every result, including synchronous throws.
 * Throw an AggregateError with recursively flattened failures and the caller's message.
 */
export async function settleAll(steps: Array<SettlementStep>, message: string): Promise<void> {
  throwFailures(await Promise.allSettled(steps.map((step) => toPromise(step))), message)
}

/**
 * Run steps in order, continuing after each failure.
 * Throw an AggregateError with recursively flattened failures and the caller's message.
 */
export async function settleSequential(
  steps: Array<SettlementStep>,
  message: string,
): Promise<void> {
  const results: Array<PromiseSettledResult<unknown>> = []
  for (const step of steps) {
    try {
      results.push({ status: 'fulfilled', value: await step() })
    } catch (reason) {
      results.push({ status: 'rejected', reason })
    }
  }
  throwFailures(results, message)
}
