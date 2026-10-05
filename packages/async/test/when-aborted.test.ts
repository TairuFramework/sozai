import { getEventListeners } from 'node:events'
import { describe, expect, test } from 'vitest'

import { whenAborted } from '../src/index.js'

describe('whenAborted()', () => {
  test('resolves immediately for an already-aborted signal without adding a listener', async () => {
    const signal = AbortSignal.abort(new Error('cancelled'))
    await expect(whenAborted(signal)).resolves.toBeUndefined()
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  })

  test('waits for abort, resolves regardless of reason, and removes its listener', async () => {
    const controller = new AbortController()
    const promise = whenAborted(controller.signal)
    let settled = false
    void promise.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
    controller.abort(new Error('cancelled'))
    await expect(promise).resolves.toBeUndefined()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})
