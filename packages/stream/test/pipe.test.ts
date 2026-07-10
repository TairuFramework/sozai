import { describe, expect, test } from 'vitest'

import { createPipe } from '../src/index.js'

describe('createPipe()', () => {
  test('reads after writes', async () => {
    const { readable, writable } = createPipe<string>()

    const writer = writable.getWriter()
    await writer.write('one')
    await writer.write('two')
    await writer.close()

    const reader = readable.getReader()
    const values: Array<string> = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      values.push(value)
    }
    expect(values).toEqual(['one', 'two'])
  })

  test('drain closes readable and flushes buffered values', async () => {
    const pipe = createPipe<string>()

    const received: Array<string> = []
    const pipePromise = pipe.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          received.push(chunk)
        },
      }),
    )

    const writer = pipe.writable.getWriter()
    await writer.write('one')
    await writer.write('two')

    // Drain bypasses the writer lock and waits for pipeTo to flush
    await pipe.drain(pipePromise)

    expect(received).toEqual(['one', 'two'])
  })

  test('write and read loop', async () => {
    const values = ['one', 'two', 'three']
    const { readable, writable } = createPipe()
    const reader = readable.getReader()
    const writer = writable.getWriter()

    let count = 0
    while (true) {
      const nextWrite = values.shift()
      if (nextWrite == null) {
        await writer.close()
      } else {
        await writer.write(nextWrite)
      }

      const nextRead = await reader.read()
      if (nextRead.done) {
        break
      }
      count++
    }

    expect(count).toBe(3)
    expect(values).toHaveLength(0)
  })

  test('drain then writer.close() resolves', async () => {
    const pipe = createPipe<string>()

    const received: Array<string> = []
    const pipePromise = pipe.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          received.push(chunk)
        },
      }),
    )

    const writer = pipe.writable.getWriter()
    await writer.write('one')
    await pipe.drain(pipePromise)

    // drain() already closed the controller; the writer must not reject on close
    await expect(writer.close()).resolves.toBeUndefined()
    expect(received).toEqual(['one'])
  })

  test('abort errors the readable with the same reason', async () => {
    const { readable, writable } = createPipe<string>()
    const reason = new Error('gone')

    const reader = readable.getReader()
    const read = reader.read()

    await writable.abort(reason)

    await expect(read).rejects.toBe(reason)
  })

  test('cancel rejects the next write with the cancel reason', async () => {
    const { readable, writable } = createPipe<string>()
    const reason = new Error('receiver left')

    await readable.cancel(reason)

    const writer = writable.getWriter()
    await expect(writer.write('one')).rejects.toBe(reason)
  })

  test('cancel rejects a subsequent close with the cancel reason', async () => {
    const { readable, writable } = createPipe<string>()
    const reason = new Error('receiver left')

    await readable.cancel(reason)

    const writer = writable.getWriter()
    await expect(writer.close()).rejects.toBe(reason)
  })
})
