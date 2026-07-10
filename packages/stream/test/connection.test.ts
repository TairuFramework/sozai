import { describe, expect, test } from 'vitest'

import { createConnection } from '../src/connection.js'

describe('createConnection()', () => {
  test('reads and writes', async () => {
    const [client, server] = createConnection<string>()
    const clientReader = client.readable.getReader()
    const clientWriter = client.writable.getWriter()
    const serverReader = server.readable.getReader()
    const serverWriter = server.writable.getWriter()

    await clientWriter.write('hello from client')
    const serverRead1 = await serverReader.read()
    expect(serverRead1.done).toBe(false)
    expect(serverRead1.value).toBe('hello from client')

    await serverWriter.write('hello from server')
    const clientRead1 = await clientReader.read()
    expect(clientRead1.done).toBe(false)
    expect(clientRead1.value).toBe('hello from server')

    await clientWriter.close()
    const serverRead2 = await serverReader.read()
    expect(serverRead2.done).toBe(true)

    await serverWriter.close()
    const clientRead2 = await clientReader.read()
    expect(clientRead2.done).toBe(true)
  })

  test('aborting one side errors the peer pending read', async () => {
    const [client, server] = createConnection<string>()
    const reason = new Error('client gone')

    const serverReader = server.readable.getReader()
    const read = serverReader.read()

    await client.writable.abort(reason)

    await expect(read).rejects.toBe(reason)
  })

  test('cancelling a readable rejects the peer next write', async () => {
    const [client, server] = createConnection<string>()
    const reason = new Error('server stopped reading')

    await server.readable.cancel(reason)

    const clientWriter = client.writable.getWriter()
    await expect(clientWriter.write('hello')).rejects.toBe(reason)
  })

  test('one direction aborting leaves the other usable', async () => {
    const [client, server] = createConnection<string>()

    await client.writable.abort(new Error('client gone'))

    const serverWriter = server.writable.getWriter()
    await serverWriter.write('still here')
    const clientRead = await client.readable.getReader().read()
    expect(clientRead.value).toBe('still here')
  })

  test('highWaterMark applies to both directions', async () => {
    const [client, server] = createConnection<string>({ highWaterMark: 1 })

    const clientWriter = client.writable.getWriter()
    await clientWriter.write('one')

    let settled = false
    const parked = clientWriter.write('two').then(() => {
      settled = true
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)

    const serverReader = server.readable.getReader()
    await expect(serverReader.read()).resolves.toEqual({ done: false, value: 'one' })
    await parked
    expect(settled).toBe(true)
  })
})
