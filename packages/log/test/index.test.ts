import type { Config, LogRecord } from '@logtape/logtape'
import { getConfig } from '@logtape/logtape'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  getDefaultConfig,
  getLogger,
  getReporter,
  getSozaiLogger,
  isSetup,
  reset,
  setup,
} from '../src/index.js'

// Routes both the package's own category and a `test` category into `records`, at
// `debug` so every level is captured. The default config routes every category at
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

  test('routes any category to a console sink at error level', () => {
    const config = getDefaultConfig()
    expect(Object.keys(config.sinks)).toEqual(['console'])
    expect(config.loggers).toEqual([{ category: [], lowestLevel: 'error', sinks: ['console'] }])
  })

  /**
   * The structural assertion above would pass against a root logger wired to no sink. This is the
   * behaviour that actually matters, and the reason it is asserted against the REAL default config
   * rather than a bespoke one: a test that configures its own sink proves only that logging works
   * when someone already thought about the category, which is not the failing case.
   */
  test('carries a category nobody configured, at error level', () => {
    const error = vi.fn()
    const fakeConsole = { error } as unknown as Console
    setup(getDefaultConfig({ console: fakeConsole }))
    getLogger(['kumiai', 'rpc']).error('the push lane ended')
    expect(error).toHaveBeenCalledOnce()
  })

  /** The blast radius stays bounded: a root SINK is not a root VOLUME. */
  test('drops an unconfigured category below error level', () => {
    const methods = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      log: vi.fn(),
    }
    setup(getDefaultConfig({ console: methods as unknown as Console }))
    getLogger(['kumiai', 'rpc']).info('chatty')
    getLogger(['kumiai', 'rpc']).warn('also chatty')
    for (const method of Object.values(methods)) {
      expect(method).not.toHaveBeenCalled()
    }
  })

  /** An app that deliberately narrows a category still wins. The root logger is a floor, not a law. */
  test('is overridden by an app that narrows a category', () => {
    const error = vi.fn()
    const fakeConsole = { error } as unknown as Console
    const config = getDefaultConfig({ console: fakeConsole })
    setup({
      ...config,
      loggers: [
        ...config.loggers,
        { category: ['kumiai'], lowestLevel: null, sinks: [], parentSinks: 'override' },
      ],
    })
    getLogger(['kumiai', 'rpc']).error('silenced on purpose')
    expect(error).not.toHaveBeenCalled()
  })

  /**
   * `toHaveBeenCalledOnce` also pins single dispatch. `parentSinks` defaults to 'inherit', which
   * UNIONS a category's own sinks with its parent's and does not de-duplicate by sink identity — so
   * a `['sozai']` entry naming the same sink as the root entry would print every sozai error twice.
   */
  test('passes the console option through to the console sink', () => {
    const error = vi.fn()
    const fakeConsole = { error } as unknown as Console
    setup(getDefaultConfig({ console: fakeConsole }))
    getSozaiLogger('test').error('boom')
    expect(error).toHaveBeenCalledOnce()
  })
})

describe('getReporter', () => {
  beforeEach(() => {
    reset()
  })

  test('sends the record to the logger for its category when logging is configured', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    const boom = new Error('boom')
    getReporter(['test', 'lane'], '@scope/pkg')('the push lane ended', boom)
    expect(records).toHaveLength(1)
    expect(records[0].category).toEqual(['test', 'lane'])
    expect(records[0].level).toBe('error')
    expect(records[0].properties.error).toBe(boom)
  })

  /**
   * The genuine last resort: logtape drops everything when nothing is configured, so the console
   * is the only place left. Tagged with the package name because a bare line on stderr with no
   * owner is barely better than silence.
   */
  test('falls back to a tagged console line when nothing is configured', () => {
    const error = vi.fn()
    const realError = console.error
    console.error = error
    const boom = new Error('boom')
    try {
      getReporter(['test', 'lane'], '@scope/pkg')('the push lane ended', boom)
    } finally {
      console.error = realError
    }
    expect(error).toHaveBeenCalledWith('[@scope/pkg] the push lane ended', boom)
  })

  /**
   * `error` is optional because one real call site has no error to give (rpc's warnDropped reports
   * a rejected payload, not a thrown thing). Passing it through regardless would print a bare
   * `undefined` after every such line.
   */
  test('omits the error argument entirely when none was given', () => {
    const error = vi.fn()
    const realError = console.error
    console.error = error
    try {
      getReporter(['test', 'lane'], '@scope/pkg')('dropped an invalid event')
    } finally {
      console.error = realError
    }
    expect(error).toHaveBeenCalledWith('[@scope/pkg] dropped an invalid event')
  })

  test('takes a category as a string', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    getReporter('test', '@scope/pkg')('a message')
    expect(records[0].category).toEqual(['test'])
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
