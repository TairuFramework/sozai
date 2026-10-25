import { describe, expect, test } from 'vitest'

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

  test('resumes waiters one per macrotask turn, in FIFO order', async () => {
    const clock = createClock()
    const yielder = createYielder({ budgetMs: 8, now: clock.now })
    const calls: Array<string> = []

    clock.set(100)
    const first = yielder.maybeYield().then(() => calls.push('first'))
    const second = yielder.maybeYield().then(() => calls.push('second'))
    const probe = new Promise<void>((resolve) => {
      setTimeout(() => {
        calls.push('probe')
        resolve()
      }, 0)
    })

    await Promise.all([first, second, probe])
    expect(calls).toEqual(['first', 'probe', 'second'])
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

describe('maybeYield()', () => {
  test('uses the shared default yielder', async () => {
    expect(defaultYielder.maybeYield).toBe(maybeYield)
    await expect(maybeYield()).resolves.toBeUndefined()
  })
})
