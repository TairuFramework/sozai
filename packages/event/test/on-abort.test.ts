import { describe, expect, test, vi } from 'vitest'

import { EventEmitter } from '../src/index.js'

describe('EventEmitter abort integration', () => {
  test('on() with an already-aborted signal never subscribes', async () => {
    const controller = new AbortController()
    controller.abort()
    const emitter = new EventEmitter<{ ping: number }>()
    const listener = vi.fn()
    emitter.on('ping', listener, { signal: controller.signal })
    await emitter.emit('ping', 1)
    expect(listener).not.toHaveBeenCalled()
  })

  test('once() rejects when its signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    const emitter = new EventEmitter<{ ping: number }>()
    await expect(emitter.once('ping', { signal: controller.signal })).rejects.toThrow('gone')
  })
})
