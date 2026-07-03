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
