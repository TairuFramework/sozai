import { describe, expect, test } from 'vitest'
import { parsePath } from '../src/apply.js'
import { applyPatches, PatchError } from '../src/index.js'

describe('parsePath() prototype-pollution guard', () => {
  test('rejects __proto__ segment', () => {
    expect(() => parsePath('/__proto__')).toThrow(PatchError)
    expect(() => parsePath('/__proto__/x')).toThrow('Forbidden path segment')
  })

  test('rejects constructor and prototype segments', () => {
    expect(() => parsePath('/constructor/prototype/x')).toThrow(PatchError)
    expect(() => parsePath('/a/prototype')).toThrow(PatchError)
  })

  test('does not pollute Object.prototype through apply', () => {
    const data: Record<string, unknown> = {}
    expect(() =>
      applyPatches(data, [{ op: 'add', path: '/__proto__/polluted', value: true }]),
    ).toThrow(PatchError)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('parsePath() strict index parsing', () => {
  test('parses real indices as numbers', () => {
    expect(parsePath('/foo/0')).toEqual(['foo', 0])
    expect(parsePath('/foo/12/bar')).toEqual(['foo', 12, 'bar'])
  })

  test('keeps non-canonical numerics as string keys', () => {
    expect(parsePath('/01')).toEqual(['01'])
    expect(parsePath('/1e2')).toEqual(['1e2'])
    expect(parsePath('/0x10')).toEqual(['0x10'])
    expect(parsePath('/1.5')).toEqual(['1.5'])
    expect(parsePath('/ ')).toEqual([' '])
    expect(parsePath('/-1')).toEqual(['-1'])
  })

  test('keeps the append sentinel as a string', () => {
    expect(parsePath('/arr/-')).toEqual(['arr', '-'])
  })
})
