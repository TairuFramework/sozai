import { describe, expect, test, vi } from 'vitest'

import { fromJSONLines, toJSONLines } from '../src/json-lines.js'
import { createReadable } from '../src/readable.js'
import { createArraySink } from '../src/writable.js'

describe('fromJSONLines()', () => {
  test('parses JSON lines to individual values', async () => {
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines()).pipeTo(sink)

    controller.enqueue(JSON.stringify({ foo: 'bar' }))
    controller.enqueue(new TextEncoder().encode('\n{"test":'))
    controller.enqueue('"other"}\n')
    controller.close()

    await expect(result).resolves.toEqual([{ foo: 'bar' }, { test: 'other' }])
  })

  test('rejects a raw newline inside a string', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('{"foo": "bar\nbaz"}\n')
    controller.enqueue('{"ok":true}\n')
    controller.close()

    // A raw newline in a string literal is invalid JSON: report it, do not repair it
    await expect(result).resolves.toEqual([{ ok: true }])
    expect(onInvalidJSON).toHaveBeenCalledWith(
      '{"foo": "bar',
      expect.any(TransformStreamDefaultController),
    )
  })

  test('rejects a raw newline after a trailing backslash in a string', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('{"foo": "bar\\\nbaz"}\n')
    controller.enqueue('{"ok":true}\n')
    controller.close()

    await expect(result).resolves.toEqual([{ ok: true }])
    expect(onInvalidJSON).toHaveBeenCalledWith(
      '{"foo": "bar\\',
      expect.any(TransformStreamDefaultController),
    )
  })

  test('parses formatted JSON', async () => {
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines()).pipeTo(sink)

    controller.enqueue(`
      {
        "foo": "bar"
    `)
    controller.enqueue(`,
        "baz": "qux"`)
    controller.enqueue('}')
    controller.close()

    await expect(result).resolves.toEqual([{ foo: 'bar', baz: 'qux' }])
  })

  test('flushes buffered value when source is closed', async () => {
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines()).pipeTo(sink)

    controller.enqueue('{"partial": "json"}')
    controller.close()

    await expect(result).resolves.toEqual([{ partial: 'json' }])
  })

  test('supports primitive values', async () => {
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines()).pipeTo(sink)

    controller.enqueue('null\n')
    controller.enqueue('true\n')
    controller.enqueue('false\n')
    controller.enqueue('"test"\n')
    controller.enqueue('123\n')
    controller.close()

    await expect(result).resolves.toEqual([null, true, false, 'test', 123])
  })

  test('calls onInvalidJSON when JSON is invalid', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('{"invalid": json}')
    controller.close()

    await expect(result).resolves.toEqual([])
    expect(onInvalidJSON).toHaveBeenCalledWith(
      '{"invalid": json}',
      expect.any(TransformStreamDefaultController),
    )
  })

  test('rejects messages exceeding maxMessageSize', async () => {
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    const pipe = source
      .pipeThrough(fromJSONLines({ maxMessageSize: 50 }))
      .pipeTo(sink)
      .catch(() => {})

    const largeObj = JSON.stringify({ data: 'x'.repeat(100) })
    controller.enqueue(`${largeObj}\n`)
    controller.close()

    await expect(result).rejects.toThrow('exceeds maximum message size')
    await pipe
  })

  test('accepts messages within maxMessageSize', async () => {
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ maxMessageSize: 200 })).pipeTo(sink)

    const smallObj = JSON.stringify({ data: 'ok' })
    controller.enqueue(`${smallObj}\n`)
    controller.close()

    await expect(result).resolves.toEqual([{ data: 'ok' }])
  })

  test('rejects oversized message on flush (no trailing newline)', async () => {
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    const pipe = source
      .pipeThrough(fromJSONLines({ maxMessageSize: 50 }))
      .pipeTo(sink)
      .catch(() => {})

    const largeObj = JSON.stringify({ data: 'x'.repeat(100) })
    controller.enqueue(largeObj)
    controller.close()

    await expect(result).rejects.toThrow('exceeds maximum message size')
    await pipe
  })

  test('rejects oversized message arriving across multiple chunks', async () => {
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    const pipe = source
      .pipeThrough(fromJSONLines({ maxMessageSize: 50 }))
      .pipeTo(sink)
      .catch(() => {})

    controller.enqueue('{"data":"')
    controller.enqueue('x'.repeat(100))
    controller.enqueue('"}\n')
    controller.close()

    await expect(result).rejects.toThrow('exceeds maximum message size')
    await pipe
  })

  test('rejects accumulated input exceeding maxBufferSize', async () => {
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    const pipe = source
      .pipeThrough(fromJSONLines({ maxBufferSize: 50 }))
      .pipeTo(sink)
      .catch(() => {})

    controller.enqueue('x'.repeat(60))
    controller.close()

    await expect(result).rejects.toThrow('exceeds maximum buffer size')
    await pipe
  })

  test('decodes multi-byte UTF-8 characters split across chunks', async () => {
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines()).pipeTo(sink)

    const bytes = new TextEncoder().encode('{"text":"héllo 🌍"}\n')
    // Split inside the 2-byte 'é' (bytes 10-11) and inside the 4-byte '🌍' (bytes 16-19)
    controller.enqueue(bytes.slice(0, 11))
    controller.enqueue(bytes.slice(11, 18))
    controller.enqueue(bytes.slice(18))
    controller.close()

    await expect(result).resolves.toEqual([{ text: 'héllo 🌍' }])
  })

  test('logs a warning by default when a line is invalid JSON', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const [source, controller] = createReadable()
      const [sink, result] = createArraySink()
      source.pipeThrough(fromJSONLines()).pipeTo(sink)

      controller.enqueue('{"invalid": json}\n')
      controller.close()

      await expect(result).resolves.toEqual([])
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid JSON line dropped'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('bounds multi-line accumulation under maxBufferSize alone', async () => {
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    const pipe = source
      .pipeThrough(fromJSONLines({ maxBufferSize: 50 }))
      .pipeTo(sink)
      .catch(() => {})

    // Each chunk is a single '[' on its own line: input stays tiny (trimmed at the
    // newline) but `output` accumulates an ever-deeper, never-closing structure.
    // maxMessageSize is intentionally unset — maxBufferSize alone must catch this.
    for (let i = 0; i < 60; i++) {
      controller.enqueue('[\n')
    }
    controller.close()

    await expect(result).rejects.toThrow('exceeds maximum buffer size')
    await pipe
  })

  test('keeps decoder state isolated between concurrent streams', async () => {
    const [sourceA, controllerA] = createReadable()
    const [sourceB, controllerB] = createReadable()
    const [sinkA, resultA] = createArraySink()
    const [sinkB, resultB] = createArraySink()
    sourceA.pipeThrough(fromJSONLines()).pipeTo(sinkA)
    sourceB.pipeThrough(fromJSONLines()).pipeTo(sinkB)

    const bytesA = new TextEncoder().encode('{"a":"é"}\n')
    const bytesB = new TextEncoder().encode('{"b":"ü"}\n')
    // Interleave chunks from both streams, splitting inside each 2-byte character (bytes 6-7)
    controllerA.enqueue(bytesA.slice(0, 7))
    controllerB.enqueue(bytesB.slice(0, 7))
    controllerA.enqueue(bytesA.slice(7))
    controllerB.enqueue(bytesB.slice(7))
    controllerA.close()
    controllerB.close()

    await expect(resultA).resolves.toEqual([{ a: 'é' }])
    await expect(resultB).resolves.toEqual([{ b: 'ü' }])
  })

  test('ignores blank and whitespace-only lines', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('\n')
    controller.enqueue('   \n')
    controller.enqueue('{"foo":"bar"}\n')
    controller.close()

    await expect(result).resolves.toEqual([{ foo: 'bar' }])
    expect(onInvalidJSON).not.toHaveBeenCalled()
  })

  test('a discarded whitespace-only line does not leak into the next message', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('   \n')
    controller.enqueue('bad json\n')
    controller.close()

    await expect(result).resolves.toEqual([])
    // The reported text is the offending line, not the prior line's whitespace spliced on
    expect(onInvalidJSON).toHaveBeenCalledWith(
      'bad json',
      expect.any(TransformStreamDefaultController),
    )
  })

  test('a discarded whitespace-only line does not consume maxMessageSize', async () => {
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ maxMessageSize: 4 })).pipeTo(sink)

    controller.enqueue('   \n')
    controller.enqueue('{}\n')
    controller.close()

    // `{}` is 2 characters; the 3 spaces on the prior line must not count against the cap
    await expect(result).resolves.toEqual([{}])
  })

  test('recovers from a stray closing bracket', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('{"first":1}\n')
    controller.enqueue(']\n')
    controller.enqueue('{"second":2}\n')
    controller.close()

    // The stray bracket costs exactly one message; the framer keeps going
    await expect(result).resolves.toEqual([{ first: 1 }, { second: 2 }])
    expect(onInvalidJSON).toHaveBeenCalledTimes(1)
    expect(onInvalidJSON).toHaveBeenCalledWith(']', expect.any(TransformStreamDefaultController))
  })

  test('reports the whole offending line when a bracket unbalances mid-line', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('{"a":1}}{"b":2}\n')
    controller.enqueue('{"ok":true}\n')
    controller.close()

    await expect(result).resolves.toEqual([{ ok: true }])
    expect(onInvalidJSON).toHaveBeenCalledWith(
      '{"a":1}}{"b":2}',
      expect.any(TransformStreamDefaultController),
    )
  })

  test('recovers from a stray closing bracket inside a multi-line message', async () => {
    const onInvalidJSON = vi.fn()
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink()
    source.pipeThrough(fromJSONLines({ onInvalidJSON })).pipeTo(sink)

    controller.enqueue('{\n')
    controller.enqueue('"a":1}}\n')
    controller.enqueue('{"next":true}\n')
    controller.close()

    await expect(result).resolves.toEqual([{ next: true }])
    expect(onInvalidJSON).toHaveBeenCalledWith(
      '{"a":1}}',
      expect.any(TransformStreamDefaultController),
    )
  })

  test('infers the message type from a custom decode', async () => {
    type Message = { kind: string }
    const [source, controller] = createReadable()
    const [sink, result] = createArraySink<Message>()

    const decode = (value: string): Message => JSON.parse(value) as Message
    source.pipeThrough(fromJSONLines({ decode })).pipeTo(sink)

    controller.enqueue('{"kind":"ping"}\n')
    controller.close()

    await expect(result).resolves.toEqual([{ kind: 'ping' }])
  })
})

test('toJSONLines() encodes values to JSON lines', async () => {
  const [source, controller] = createReadable()
  const [sink, result] = createArraySink()
  source.pipeThrough(toJSONLines()).pipeTo(sink)

  controller.enqueue({ foo: 'foo' })
  controller.enqueue({ bar: 'bar' })
  controller.close()

  await expect(result).resolves.toEqual(['{"foo":"foo"}\n', '{"bar":"bar"}\n'])
})
