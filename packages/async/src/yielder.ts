/** Default time budget, in milliseconds, a caller may run before {@link Yielder.maybeYield} yields. */
export const DEFAULT_YIELD_BUDGET_MS = 8

export type YielderOptions = {
  /** Time in milliseconds work may run without a macrotask turn before yielding. Defaults to 8. */
  budgetMs?: number
  /** Clock returning the current time in milliseconds. Defaults to `Date.now`. */
  now?: () => number
}

export type Yielder = {
  /**
   * Resolves immediately while a macrotask turn has happened within the budget, otherwise waits
   * for a macrotask turn. Call between units of work in long async loops.
   */
  maybeYield: () => Promise<void>
}

/**
 * Creates a cooperative yielder for long-running async loops.
 *
 * Promise chains never return to the event loop on their own, so a loop of async work can starve
 * rendering, I/O and timers. `maybeYield()` tracks when the event loop last completed a macrotask
 * turn (via a sentinel `setTimeout(…, 0)`) and, once the budget is exceeded, waits for a real
 * macrotask turn. It deliberately uses `setTimeout` rather than `setImmediate` (which runs before
 * native events are drained on React Native) or microtasks (which never yield).
 *
 * Waiters resume one per macrotask turn in FIFO order, so concurrent loops interleave with the
 * event loop instead of all resuming in a single microtask drain. While waiters are queued, new
 * callers queue behind them even if within budget.
 */
export function createYielder(options: YielderOptions = {}): Yielder {
  const budgetMs = options.budgetMs ?? DEFAULT_YIELD_BUDGET_MS
  const now = options.now ?? Date.now

  const waiters: Array<() => void> = []
  let lastTurn = now()
  let marking = false
  let pumping = false

  const mark = (): void => {
    lastTurn = now()
    marking = false
  }

  const pump = (): void => {
    lastTurn = now()
    const next = waiters.shift()
    if (waiters.length > 0) {
      setTimeout(pump, 0)
    } else {
      pumping = false
    }
    next?.()
  }

  async function maybeYield(): Promise<void> {
    if (!marking) {
      marking = true
      setTimeout(mark, 0)
    }
    if (waiters.length === 0 && now() - lastTurn < budgetMs) {
      return
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve)
      if (!pumping) {
        pumping = true
        setTimeout(pump, 0)
      }
    })
  }

  return { maybeYield }
}

/** Shared yielder so independent libraries cooperate on a single clock and queue. */
export const defaultYielder: Yielder = createYielder()

/** {@link Yielder.maybeYield} of the shared {@link defaultYielder}. */
export const maybeYield: () => Promise<void> = defaultYielder.maybeYield
