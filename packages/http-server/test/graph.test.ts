import { describe, expect, test } from 'vitest'

import { sortPlugins } from '../src/graph.js'
import { PluginGraphError } from '../src/index.js'
import type { AnyHTTPPlugin } from '../src/types.js'

function plugin(name: string, dependsOn: Array<string> = []): AnyHTTPPlugin {
  return { name, dependsOn, setup: () => undefined }
}

function catchError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected function to throw')
}

describe('sortPlugins', () => {
  test('orders dependencies first, keeping list order for ties', () => {
    const sorted = sortPlugins([plugin('c', ['a']), plugin('a'), plugin('b')])
    expect(sorted.map((p) => p.name)).toEqual(['a', 'c', 'b'])
  })

  test('rejects duplicate names', () => {
    const error = catchError(() => sortPlugins([plugin('a'), plugin('a')]))
    expect(error).toBeInstanceOf(PluginGraphError)
    expect((error as PluginGraphError).plugin).toBe('a')
    expect((error as PluginGraphError).message).toContain('duplicate')
  })

  test('rejects missing dependencies', () => {
    const error = catchError(() => sortPlugins([plugin('b', ['x'])]))
    expect(error).toBeInstanceOf(PluginGraphError)
    expect((error as PluginGraphError).plugin).toBe('b')
    expect((error as PluginGraphError).message).toContain("'x'")
  })

  test('rejects cycles', () => {
    const error = catchError(() => sortPlugins([plugin('a', ['b']), plugin('b', ['a'])]))
    expect(error).toBeInstanceOf(PluginGraphError)
    const message = (error as PluginGraphError).message
    expect(message).toContain('cycle')
    expect(message).toContain("'a'")
    expect(message).toContain("'b'")
  })
})
