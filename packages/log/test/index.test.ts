import type { Config, LogRecord } from '@logtape/logtape'
import { getConfig } from '@logtape/logtape'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { getDefaultConfig, getLogger, getSozaiLogger, isSetup, reset, setup } from '../src/index.js'

// Routes both the package's own category and a `test` category into `records`, at
// `debug` so every level is captured. The default config only routes `sozai` at
// `error`, which would drop most records under test.
function memoryConfig(records: Array<LogRecord>): Config<string, string> {
  return {
    sinks: {
      memory: (record: LogRecord) => {
        records.push(record)
      },
    },
    loggers: [
      { category: ['sozai'], lowestLevel: 'debug', sinks: ['memory'] },
      { category: ['test'], lowestLevel: 'debug', sinks: ['memory'] },
    ],
  }
}

describe('reset', () => {
  beforeEach(() => {
    reset()
  })

  test('clears the configuration', () => {
    setup()
    expect(getConfig()).not.toBeNull()
    reset()
    expect(getConfig()).toBeNull()
  })

  test('allows setup() to configure again', () => {
    setup()
    reset()
    setup(getDefaultConfig())
    expect(getConfig()).not.toBeNull()
  })
})

describe('setup', () => {
  beforeEach(() => {
    reset()
  })

  test('applies the default configuration when called with no arguments', () => {
    setup()
    expect(getConfig()).not.toBeNull()
  })

  test('applies the given configuration', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    expect(getConfig()?.sinks).toHaveProperty('memory')
  })

  test('does not throw when called twice', () => {
    setup()
    expect(() => {
      setup()
    }).not.toThrow()
  })

  test('keeps the first configuration when called twice', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    setup(getDefaultConfig())
    expect(getConfig()?.sinks).toHaveProperty('memory')
    expect(getConfig()?.sinks).not.toHaveProperty('console')
  })

  test('logs an error on the already-configured logger when called twice', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    setup()
    expect(records).toHaveLength(1)
    expect(records[0].level).toBe('error')
    expect(records[0].category).toEqual(['sozai', 'log'])
    expect(records[0].rawMessage).toBe('Logging already configured, setup() call ignored')
  })

  test("notifies through the default configuration's console sink", () => {
    const error = vi.fn()
    const fakeConsole = { error } as unknown as Console
    setup(getDefaultConfig({ console: fakeConsole }))
    setup()
    expect(error).toHaveBeenCalledOnce()
  })
})

describe('getLogger', () => {
  beforeEach(() => {
    reset()
  })

  test('takes a category as a string', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    getLogger('test').info('hello')
    expect(records).toHaveLength(1)
    expect(records[0].category).toEqual(['test'])
    expect(records[0].rawMessage).toBe('hello')
  })

  test('takes a category as an array', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    getLogger(['test', 'nested']).info('hello')
    expect(records[0].category).toEqual(['test', 'nested'])
  })

  test('attaches the given properties to records', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    getLogger('test', { requestID: 'abc' }).info('hello')
    expect(records[0].properties).toMatchObject({ requestID: 'abc' })
  })
})

describe('getSozaiLogger', () => {
  beforeEach(() => {
    reset()
  })

  test('namespaces the category under sozai', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    getSozaiLogger('otel').info('hello')
    expect(records[0].category).toEqual(['sozai', 'otel'])
  })

  test('attaches the given properties to records', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    getSozaiLogger('otel', { traceID: 'abc' }).info('hello')
    expect(records[0].properties).toMatchObject({ traceID: 'abc' })
  })
})

describe('getDefaultConfig', () => {
  beforeEach(() => {
    reset()
  })

  test('routes the sozai and logtape meta categories to a console sink at error level', () => {
    const config = getDefaultConfig()
    expect(Object.keys(config.sinks)).toEqual(['console'])
    expect(config.loggers).toEqual([
      { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: ['console'] },
      { category: ['sozai'], lowestLevel: 'error', sinks: ['console'] },
    ])
  })

  test('passes the console option through to the console sink', () => {
    const error = vi.fn()
    const fakeConsole = { error } as unknown as Console
    setup(getDefaultConfig({ console: fakeConsole }))
    getSozaiLogger('test').error('boom')
    expect(error).toHaveBeenCalledOnce()
  })
})

describe('isSetup', () => {
  beforeEach(() => {
    reset()
  })

  test('is false before setup() is called', () => {
    expect(isSetup()).toBe(false)
  })

  test('is true after setup() is called', () => {
    setup()
    expect(isSetup()).toBe(true)
  })

  test('is false again after reset()', () => {
    setup()
    reset()
    expect(isSetup()).toBe(false)
  })
})
