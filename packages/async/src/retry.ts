import { TimeoutInterruption } from './interruptions.js'
import { onAbort } from './on-abort.js'
import { sleep } from './utils.js'

/** Exponential delay settings for retries. */
export type RetryBackoff = {
  initialMs: number
  multiplier?: number
  maxMs?: number
  jitter?: boolean
}

/** Bounds for attempts and total execution time. */
export type RetryPolicy = {
  maxAttempts: number
  attemptTimeoutMs?: number
  totalTimeoutMs?: number
  backoff?: RetryBackoff
}

/** Whether to retry, with an optional minimum delay. */
export type RetryDecision = boolean | { afterMs: number }

/** Dependencies and callbacks for a retry run. */
export type RetryParams = {
  policy: RetryPolicy
  signal?: AbortSignal
  retryable?: (error: unknown) => RetryDecision
  onRetry?: (event: { attempt: number; delayMs: number; error: unknown }) => void
  random?: () => number
  now?: () => number
}

/** Largest delay accepted by JavaScript timers. */
export const MAX_DELAY_MS = 2_147_483_647

/** Limit that stopped a retry run. */
export type RetryExhaustedReason = 'attempts' | 'total_timeout'

/** Details of the exhausted retry run. */
export type RetryExhaustedErrorParams = {
  attempts: number
  reason: RetryExhaustedReason
  cause?: unknown
}

/** Error raised when a retry limit is reached. */
export class RetryExhaustedError extends Error {
  #attempts: number
  #reason: RetryExhaustedReason

  constructor(params: RetryExhaustedErrorParams) {
    super(
      params.reason === 'attempts'
        ? `Retry exhausted after ${params.attempts} attempts`
        : `Retry stopped after ${params.attempts} attempts due to total timeout`,
      { cause: params.cause },
    )

    this.name = 'RetryExhaustedError'
    this.#attempts = params.attempts
    this.#reason = params.reason
  }

  get attempts(): number {
    return this.#attempts
  }

  get reason(): RetryExhaustedReason {
    return this.#reason
  }
}

function assertIntegerInRange(value: number, field: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > MAX_DELAY_MS) {
    throw new RangeError(`${field} must be an integer between 0 and ${MAX_DELAY_MS}`)
  }
}

/** Assert that retry policy bounds are usable by timers. */
export function assertRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 100) {
    throw new RangeError('maxAttempts must be an integer between 1 and 100')
  }

  if (policy.attemptTimeoutMs !== undefined) {
    assertIntegerInRange(policy.attemptTimeoutMs, 'attemptTimeoutMs')
  }

  if (policy.totalTimeoutMs !== undefined) {
    assertIntegerInRange(policy.totalTimeoutMs, 'totalTimeoutMs')
  }

  if (policy.backoff !== undefined) {
    assertIntegerInRange(policy.backoff.initialMs, 'initialMs')

    if (policy.backoff.maxMs !== undefined) {
      assertIntegerInRange(policy.backoff.maxMs, 'maxMs')
    }

    if (
      policy.backoff.multiplier !== undefined &&
      (!Number.isFinite(policy.backoff.multiplier) || policy.backoff.multiplier < 1)
    ) {
      throw new RangeError('multiplier must be finite and at least 1')
    }
  }
}

function clampDelay(value: number): number {
  return Math.min(MAX_DELAY_MS, Math.max(0, value))
}

/** Calculate the delay before the next attempt. */
export function getRetryDelay(
  policy: RetryPolicy,
  attempt: number,
  params: { afterMs?: number; random?: () => number } = {},
): number {
  assertRetryPolicy(policy)

  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError('attempt must be an integer at least 1')
  }

  let delay = 0

  if (policy.backoff !== undefined) {
    const { initialMs, multiplier = 2, maxMs = MAX_DELAY_MS, jitter = false } = policy.backoff
    const grown = initialMs === 0 ? 0 : initialMs * multiplier ** (attempt - 1)

    delay = clampDelay(Math.min(maxMs, Number.isFinite(grown) ? grown : MAX_DELAY_MS))

    if (jitter) {
      delay = clampDelay(delay * (params.random ?? Math.random)())
    }
  }

  if (params.afterMs !== undefined && Number.isFinite(params.afterMs)) {
    delay = Math.max(delay, clampDelay(params.afterMs))
  }

  return clampDelay(delay)
}

function timeoutInterruption(kind: 'attempt' | 'deadline', delay: number): TimeoutInterruption {
  return new TimeoutInterruption({
    message:
      kind === 'attempt' ? `Attempt timed out after ${delay}ms` : 'Total retry timeout reached',
    cause: kind,
  })
}

/** Dependencies and time bounds for one attempt. */
export type RaceAttemptParams<Result> = {
  fn: (signal: AbortSignal) => Promise<Result>
  signal?: AbortSignal
  timeoutMs?: number
  deadline?: number
  now?: () => number
}

/** Race one attempt against abort and timeout signals. */
export function raceAttempt<Result>(params: RaceAttemptParams<Result>): Promise<Result> {
  const now = params.now ?? Date.now

  if (params.signal?.aborted) {
    return Promise.reject(params.signal.reason)
  }

  if (params.deadline !== undefined && params.deadline <= now()) {
    return Promise.reject(timeoutInterruption('deadline', 0))
  }

  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let unsubscribe = () => {}

  const attempt = Promise.resolve().then(() => params.fn(controller.signal))

  const interrupted = new Promise<never>((_resolve, reject) => {
    const abort = (reason: unknown) => {
      if (!controller.signal.aborted) {
        controller.abort(reason)
      }

      reject(reason)
    }

    unsubscribe = onAbort(params.signal, () => abort(params.signal?.reason))

    const deadlineDelay = params.deadline === undefined ? undefined : params.deadline - now()

    const deadlineFirst =
      deadlineDelay !== undefined &&
      (params.timeoutMs === undefined || deadlineDelay <= params.timeoutMs)

    const delay = deadlineFirst ? deadlineDelay : params.timeoutMs

    if (delay !== undefined) {
      const kind = deadlineFirst ? 'deadline' : 'attempt'

      timeout = setTimeout(() => abort(timeoutInterruption(kind, delay)), Math.max(0, delay))
    }
  })

  return Promise.race([attempt, interrupted]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }

    unsubscribe()
  })
}

/** Retry an asynchronous operation within the supplied policy bounds. */
export async function retry<Result>(
  fn: (ctx: { attempt: number; signal: AbortSignal }) => Promise<Result>,
  params: RetryParams,
): Promise<Result> {
  const { policy, signal } = params

  assertRetryPolicy(policy)

  const now = params.now ?? Date.now
  const start = now()
  const deadline = policy.totalTimeoutMs === undefined ? undefined : start + policy.totalTimeoutMs

  const retryable =
    params.retryable ??
    ((error: unknown) => error instanceof TimeoutInterruption && error.cause === 'attempt')

  let lastError: unknown

  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) {
      throw signal.reason
    }

    if (deadline !== undefined && deadline <= now()) {
      throw new RetryExhaustedError({
        attempts: attempt - 1,
        reason: 'total_timeout',
        cause: lastError,
      })
    }

    let error: unknown

    try {
      return await raceAttempt({
        fn: (attemptSignal) => fn({ attempt, signal: attemptSignal }),
        signal,
        timeoutMs: policy.attemptTimeoutMs,
        deadline,
        now,
      })
    } catch (caught) {
      if (signal?.aborted) {
        throw signal.reason
      }

      if (caught instanceof TimeoutInterruption && caught.cause === 'deadline') {
        // biome-ignore lint/style/useErrorCause: RetryExhaustedError preserves this timeout as its cause.
        throw new RetryExhaustedError({ attempts: attempt, reason: 'total_timeout', cause: caught })
      }

      error = caught
      lastError = caught
    }

    const decision = retryable(error)

    if (decision === false) {
      throw error
    }

    if (attempt >= policy.maxAttempts) {
      throw new RetryExhaustedError({ attempts: attempt, reason: 'attempts', cause: error })
    }

    const afterMs = typeof decision === 'object' ? decision.afterMs : undefined
    const delayMs = getRetryDelay(policy, attempt, { afterMs, random: params.random })

    if (deadline !== undefined && now() + delayMs >= deadline) {
      throw new RetryExhaustedError({ attempts: attempt, reason: 'total_timeout', cause: error })
    }

    params.onRetry?.({ attempt, delayMs, error })

    if (signal?.aborted) {
      throw signal.reason
    }

    try {
      await sleep(delayMs, signal)
    } catch (caught) {
      if (signal?.aborted) {
        throw signal.reason
      }

      throw caught
    }
  }
}
