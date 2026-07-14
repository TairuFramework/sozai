import type { Logger, LogRecord as OTelLogRecord } from '@opentelemetry/api-logs'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import type { LogLevel } from '@sozai/log'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createOTelLogSink } from '../src/log-sink.js'

/** Spies on logs.getLogger() and returns the emitted OTel record captured via emit(). */
function spyOnEmit(): { getEmitted: () => OTelLogRecord } {
  let emitted: OTelLogRecord | undefined
  const logger: Logger = {
    emit: (record) => {
      emitted = record
    },
    enabled: () => true,
  }
  vi.spyOn(logs, 'getLogger').mockReturnValue(logger)
  return {
    getEmitted: () => {
      if (emitted == null) {
        throw new Error('No log record was emitted')
      }
      return emitted
    },
  }
}

describe('createOTelLogSink', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('returns a function (Sink type)', () => {
    const sink = createOTelLogSink()
    expect(typeof sink).toBe('function')
  })

  test('renders a tagged-template body from record.message, interleaving substituted values', () => {
    const { getEmitted } = spyOnEmit()
    const sink = createOTelLogSink()
    const rawMessage = Object.assign(['hello ', '!'], {
      raw: ['hello ', '!'],
    }) as unknown as TemplateStringsArray

    sink({
      category: ['sozai', 'server'],
      level: 'info',
      message: ['hello ', 'Alice', '!'],
      rawMessage,
      properties: {},
      timestamp: Date.now(),
    })

    expect(getEmitted().body).toBe('hello Alice!')
  })

  test('leaves a method-call body unsubstituted, with values in attributes', () => {
    const { getEmitted } = spyOnEmit()
    const sink = createOTelLogSink()

    sink({
      category: ['sozai', 'server'],
      level: 'info',
      message: ['Hello, ', 'Alice', '!'],
      rawMessage: 'Hello, {name}!',
      properties: { name: 'Alice' },
      timestamp: Date.now(),
    })

    const emitted = getEmitted()
    expect(emitted.body).toBe('Hello, {name}!')
    expect(emitted.attributes).toMatchObject({ name: 'Alice' })
  })

  test('maps every logtape level to the matching OTel SeverityNumber', () => {
    const { getEmitted } = spyOnEmit()
    const sink = createOTelLogSink()
    const expectations: Array<[LogLevel, SeverityNumber]> = [
      ['trace', SeverityNumber.TRACE],
      ['debug', SeverityNumber.DEBUG],
      ['info', SeverityNumber.INFO],
      ['warning', SeverityNumber.WARN],
      ['error', SeverityNumber.ERROR],
      ['fatal', SeverityNumber.FATAL],
    ]

    for (const [level, severityNumber] of expectations) {
      sink({
        category: ['sozai'],
        level,
        message: ['msg'],
        rawMessage: 'msg',
        properties: {},
        timestamp: Date.now(),
      })
      expect(getEmitted().severityNumber).toBe(severityNumber)
    }
  })

  test('renders a non-string interpolated value as JSON, not [object Object]', () => {
    const { getEmitted } = spyOnEmit()
    const sink = createOTelLogSink()
    const rawMessage = Object.assign(['payload: ', ''], {
      raw: ['payload: ', ''],
    }) as unknown as TemplateStringsArray

    sink({
      category: ['sozai'],
      level: 'info',
      message: ['payload: ', { a: 1 }, ''],
      rawMessage,
      properties: {},
      timestamp: Date.now(),
    })

    expect(getEmitted().body).toBe('payload: {"a":1}')
  })
})
