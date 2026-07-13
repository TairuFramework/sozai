import { getConfig } from '@logtape/logtape'
import { beforeEach, describe, expect, test } from 'vitest'

import { getDefaultConfig, reset, setup } from '../src/index.js'

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
