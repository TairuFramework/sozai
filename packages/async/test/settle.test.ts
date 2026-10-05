import { describe, expect, test } from 'vitest'

import { defer, settleAll, settleSequential } from '../src/index.js'

describe.each([settleAll, settleSequential])('%s', (settle) => {
  test('resolves void for empty steps and successful values or thenables', async () => {
    await expect(settle([], 'cleanup')).resolves.toBeUndefined()
    await expect(settle([() => 1, () => Promise.resolve(2)], 'cleanup')).resolves.toBeUndefined()
  })

  test('captures sync throws and rejections, recursively flattening aggregate errors', async () => {
    const first = new Error('first')
    const last = new Error('last')
    const steps = [
      () => {
        throw new AggregateError([first, new AggregateError(['nested'], 'inner')], 'outer')
      },
      () => Promise.reject(last),
      () => {
        throw undefined
      },
    ]
    await expect(settle(steps, 'caller message')).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'caller message',
      errors: [first, 'nested', last, undefined],
    })
  })

  test('rejects even when a failed aggregate contains no errors', async () => {
    await expect(
      settle([() => Promise.reject(new AggregateError([]))], 'failed'),
    ).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'failed',
      errors: [],
    })
  })
})

test('settleAll starts every step before an earlier step finishes and waits for all', async () => {
  const gate = defer<void>()
  const started = defer<void>()
  let finished = false
  const promise = settleAll(
    [
      () => gate.promise,
      () => {
        started.resolve()
        throw new Error('failed')
      },
    ],
    'cleanup',
  )
  const rejection = expect(promise).rejects.toThrow('cleanup')
  void promise.catch(() => {
    finished = true
  })

  await started.promise
  expect(finished).toBe(false)
  gate.resolve()
  await rejection
})

test('settleSequential waits in order and continues after sync and async failures', async () => {
  const gate = defer<void>()
  const started = defer<void>()
  const order: Array<number> = []
  const promise = settleSequential(
    [
      async () => {
        order.push(1)
        started.resolve()
        await gate.promise
        order.push(2)
        throw new Error('async failure')
      },
      () => {
        order.push(3)
        throw new Error('sync failure')
      },
      () => order.push(4),
    ],
    'cleanup',
  )
  const rejection = expect(promise).rejects.toThrow('cleanup')
  await started.promise
  expect(order).toEqual([1])
  gate.resolve()
  await rejection
  expect(order).toEqual([1, 2, 3, 4])
})
