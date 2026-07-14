import { describe, expect, test } from 'vitest'

import { createOTelLogSink } from '../src/log-sink.js'

describe('createOTelLogSink', () => {
  test('returns a function (Sink type)', () => {
    const sink = createOTelLogSink()
    expect(typeof sink).toBe('function')
  })

  test('accepts a log record without throwing', () => {
    const sink = createOTelLogSink()
    expect(() =>
      sink({
        category: ['sozai', 'server'],
        level: 'info',
        message: ['server started'],
        rawMessage: 'server started',
        properties: { serverID: 'test-id' },
        timestamp: Date.now(),
      }),
    ).not.toThrow()
  })

  test('accepts a tagged-template record, whose rawMessage is a TemplateStringsArray', () => {
    // logtape's rawMessage is `string | TemplateStringsArray`. The sink must not
    // hand the array straight to the OTel log body.
    const sink = createOTelLogSink()
    const rawMessage = Object.assign(['server ', ' started'], {
      raw: ['server ', ' started'],
    }) as unknown as TemplateStringsArray
    expect(() =>
      sink({
        category: ['sozai', 'server'],
        level: 'info',
        message: ['server ', 'test-id', ' started'],
        rawMessage,
        properties: {},
        timestamp: Date.now(),
      }),
    ).not.toThrow()
  })

  test('accepts every logtape level', () => {
    const sink = createOTelLogSink()
    const levels = ['trace', 'debug', 'info', 'warning', 'error', 'fatal'] as const
    for (const level of levels) {
      expect(() =>
        sink({
          category: ['sozai'],
          level,
          message: ['msg'],
          rawMessage: 'msg',
          properties: {},
          timestamp: Date.now(),
        }),
      ).not.toThrow()
    }
  })
})
