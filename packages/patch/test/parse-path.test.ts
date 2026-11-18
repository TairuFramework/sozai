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

describe('numeric object members', () => {
  test.each(['9007199254740993', '1000000000000000000000', '9'.repeat(400)])(
    'preserves the exact key %s',
    (key) => {
      expect(parsePath(`/${key}`)).toEqual([key])
      for (const op of ['set', 'add'] as const) {
        const data = { nested: {} }
        applyPatches(data, [{ op, path: `/nested/${key}`, value: { child: 1 } }])
        expect(data).toEqual({ nested: { [key]: { child: 1 } } })
        applyPatches(data, [{ op: 'replace', path: `/nested/${key}/child`, value: 2 }])
        expect(data).toEqual({ nested: { [key]: { child: 2 } } })
        applyPatches(data, [{ op: 'remove', path: `/nested/${key}` }])
        expect(data).toEqual({ nested: {} })
      }
    },
  )
})
