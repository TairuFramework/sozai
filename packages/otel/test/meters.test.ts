import { metrics } from '@opentelemetry/api'
import { describe, expect, test, vi } from 'vitest'

import { createMeterFactory } from '../src/meters.js'

describe('createMeterFactory', () => {
  test('returns a Meter from the global MeterProvider', () => {
    const meter = createMeterFactory('sozai')('mod')
    expect(typeof meter.createCounter).toBe('function')
  })

  test('forwards version and schemaUrl through the global MeterProvider', () => {
    const noop = metrics.getMeter('unused')
    const getMeter = vi.fn(() => noop)
    metrics.setGlobalMeterProvider({ getMeter })
    try {
      createMeterFactory('sozai', '1.2.3', { schemaUrl: 'https://example.test/schema' })('mod')
      expect(getMeter).toHaveBeenCalledWith('sozai.mod', '1.2.3', {
        schemaUrl: 'https://example.test/schema',
      })
    } finally {
      metrics.disable()
    }
  })
})
