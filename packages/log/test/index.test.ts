import type { Config, LogRecord } from '@logtape/logtape'
import { getConfig } from '@logtape/logtape'
import { beforeEach, describe, expect, test } from 'vitest'

import { getDefaultConfig, reset, setup } from '../src/index.js'

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
})
