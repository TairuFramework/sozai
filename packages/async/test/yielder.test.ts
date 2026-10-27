import { afterEach, describe, expect, test, vi } from 'vitest'

import { createYielder, defaultYielder, maybeYield } from '../src/yielder.js'

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function createClock(start = 0) {
  let time = start
  return {
    now: () => time,
    set: (value: number) => {
      time = value
    },
  }
}

describe('createYielder()', () => {
  test('resolves without yielding a macrotask while within budget', async () => {
    const clock = createClock()
    const yielder = createYielder({ now: clock.now })
    const calls: Array<string> = []

    setTimeout(() => calls.push('timer'), 0)
    await yielder.maybeYield()
    calls.push('resumed')

    expect(calls).toEqual(['resumed'])
    await nextTurn()
    expect(calls).toEqual(['resumed', 'timer'])
  })

  test('yields a macrotask turn when over budget', async () => {
    const clock = createClock()
    const yielder = createYielder({ budgetMs: 8, now: clock.now })
    const calls: Array<string> = []

    clock.set(100)
    setTimeout(() => calls.push('timer'), 0)
    await yielder.maybeYield()
    calls.push('resumed')

    expect(calls).toEqual(['timer', 'resumed'])
  })

  test('a completed macrotask turn resets the budget', async () => {
    const clock = createClock()
    const yielder = createYielder({ budgetMs: 8, now: clock.now })
    const calls: Array<string> = []

    // Schedules the sentinel, which records the turn time when it runs.
    await yielder.maybeYield()
    clock.set(100)
    await nextTurn()

    setTimeout(() => calls.push('timer'), 0)
    await yielder.maybeYield()
    calls.push('resumed')

    expect(calls).toEqual(['resumed'])
    await nextTurn()
  })

  test('resumes several waiters in FIFO order within one turn', async () => {
    const clock = createClock()
    const scheduled: Array<() => void> = []
    const yielder = createYielder({
      budgetMs: 8,
      now: clock.now,
      schedule: (callback) => {
        scheduled.push(callback)
      },
    })
    const calls: Array<string> = []

    clock.set(100)
    const first = yielder.maybeYield().then(() => {
      calls.push('first')
      clock.set(102)
    })
    const second = yielder.maybeYield().then(() => {
      calls.push('second')
      clock.set(104)
    })
    const third = yielder.maybeYield().then(() => {
      calls.push('third')
      clock.set(106)
    })

    for (const callback of scheduled.splice(0)) callback()
    await first
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['first', 'second', 'third'])
    expect(scheduled).toHaveLength(0)
    await Promise.all([second, third])
  })

  test('schedules another turn once resumed work uses the budget', async () => {
    const clock = createClock()
    const scheduled: Array<() => void> = []
    const yielder = createYielder({
      budgetMs: 8,
      now: clock.now,
      schedule: (callback) => {
        scheduled.push(callback)
      },
    })
    const calls: Array<string> = []

    clock.set(100)
    const first = yielder.maybeYield().then(() => {
      calls.push('first')
      clock.set(108)
    })
    const second = yielder.maybeYield().then(() => calls.push('second'))

    for (const callback of scheduled.splice(0)) callback()
    await first
    await Promise.resolve()
    expect(calls).toEqual(['first'])
    expect(scheduled).toHaveLength(1)

    scheduled.shift()?.()
    await second
    expect(calls).toEqual(['first', 'second'])
  })

  test('a resumed waiter can continue within the new turn budget', async () => {
    const clock = createClock()
    const scheduled: Array<() => void> = []
    const yielder = createYielder({
      budgetMs: 8,
      now: clock.now,
      schedule: (callback) => {
        scheduled.push(callback)
      },
    })

    clock.set(100)
    let completed = false
    const waiting = (async () => {
      await yielder.maybeYield()
      clock.set(102)
      await yielder.maybeYield()
      completed = true
    })()

    await Promise.resolve()
    expect(completed).toBe(false)
    for (const callback of scheduled.splice(0)) callback()
    await waiting
    expect(completed).toBe(true)
  })

  test('a new caller does not jump the queue even when within budget', async () => {
    const clock = createClock()
    const yielder = createYielder({ budgetMs: 8, now: clock.now })
    const calls: Array<string> = []

    // Within budget: schedules the sentinel turn marker.
    await yielder.maybeYield()

    // Runs after the sentinel (which records the turn at time 100) but before the pump.
    const late = new Promise<void>((resolve) => {
      setTimeout(() => {
        void yielder.maybeYield().then(() => {
          calls.push('late')
          resolve()
        })
      }, 0)
    })

    clock.set(100)
    const early = yielder.maybeYield().then(() => calls.push('early'))

    await Promise.all([early, late])
    expect(calls).toEqual(['early', 'late'])
  })

  test('defaults to Date.now and an 8ms budget', async () => {
    const yielder = createYielder()
    const calls: Array<string> = []

    setTimeout(() => calls.push('timer'), 0)
    await yielder.maybeYield()
    calls.push('within')
    expect(calls).toEqual(['within'])

    const start = Date.now()
    while (Date.now() - start < 20) {
      // Busy-wait past the budget without returning to the event loop.
    }
    await yielder.maybeYield()
    calls.push('over')
    expect(calls).toEqual(['within', 'timer', 'over'])
  })
})

describe('fake timers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('a yielder created before timers are faked keeps yielding on real timers', async () => {
    const clock = createClock()
    const yielder = createYielder({ budgetMs: 8, now: clock.now })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    clock.set(100)
    // With the faked setTimeout this would never resolve: nothing advances the fake clock.
    await expect(yielder.maybeYield()).resolves.toBeUndefined()
  })

  test('schedules macrotask turns with the given scheduler', async () => {
    const clock = createClock()
    const scheduled: Array<() => void> = []
    const yielder = createYielder({
      budgetMs: 8,
      now: clock.now,
      schedule: (callback) => {
        scheduled.push(callback)
      },
    })

    clock.set(100)
    let resumed = false
    const waiting = yielder.maybeYield().then(() => {
      resumed = true
    })
    await Promise.resolve()
    expect(resumed).toBe(false)
    for (const callback of scheduled.splice(0)) callback()
    await waiting
    expect(resumed).toBe(true)
  })
})

describe('maybeYield()', () => {
  test('uses the shared default yielder', async () => {
    expect(defaultYielder.maybeYield).toBe(maybeYield)
    await expect(maybeYield()).resolves.toBeUndefined()
  })
})
