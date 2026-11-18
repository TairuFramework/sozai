import { describe, expect, it } from 'vitest'

import { deletePath, getPath, PatchError, parsePath, setPath } from '../src/apply.js'
import { applyPatches } from '../src/index.js'

describe('parsePath()', () => {
  it('should parse simple paths', () => {
    expect(parsePath('/foo')).toEqual(['foo'])
    expect(parsePath('/foo/bar')).toEqual(['foo', 'bar'])
  })

  it('should parse array indices', () => {
    expect(parsePath('/foo/0')).toEqual(['foo', 0])
    expect(parsePath('/foo/1/bar')).toEqual(['foo', 1, 'bar'])
  })

  it('should handle escaped characters', () => {
    expect(parsePath('/foo~1bar')).toEqual(['foo/bar'])
    expect(parsePath('/foo~0bar')).toEqual(['foo~bar'])
  })

  it('should throw on invalid paths', () => {
    expect(() => parsePath('foo')).toThrow(PatchError)
    expect(() => parsePath('foo')).toThrow('Path must start with /')
  })
})

describe('getPath()', () => {
  const obj = {
    foo: {
      bar: [1, 2, 3],
      baz: 'qux',
    },
  }

  it('should get nested values', () => {
    expect(getPath(obj, '/foo/bar')).toEqual([1, 2, 3])
    expect(getPath(obj, '/foo/baz')).toBe('qux')
  })

  it('should get array elements', () => {
    expect(getPath(obj, '/foo/bar/0')).toBe(1)
    expect(getPath(obj, '/foo/bar/1')).toBe(2)
  })

  it('should return undefined for non-existent paths', () => {
    expect(getPath(obj, '/foo/qux')).toBeUndefined()
    expect(getPath(obj, '/foo/bar/5')).toBeUndefined()
  })
})

describe('setPath()', () => {
  it('should set values in objects', () => {
    const obj: Record<string, unknown> = { foo: { bar: 1 } }
    setPath(obj, '/foo/baz', 2)
    expect((obj.foo as Record<string, unknown>).baz).toBe(2)
  })

  it('should set values in arrays', () => {
    const arr = [1, 2, 3]
    setPath(arr, '/1', 4)
    expect(arr).toEqual([1, 4, 3])
  })

  it('should append to arrays', () => {
    const arr = [1, 2, 3]
    setPath(arr, '/3', 4)
    expect(arr).toEqual([1, 2, 3, 4])
  })

  it('should throw on invalid array indices', () => {
    const arr = [1, 2, 3]
    expect(() => setPath(arr, '/5', 4)).toThrow(PatchError)
    expect(() => setPath(arr, '/-1', 4)).toThrow(PatchError)
  })
})

describe('deletePath()', () => {
  it('should delete values from objects', () => {
    const obj: Record<string, unknown> = { foo: { bar: 1, baz: 2 } }
    deletePath(obj, '/foo/bar')
    expect(obj.foo as Record<string, unknown>).toEqual({ baz: 2 })
  })

  it('should delete values from arrays', () => {
    const arr = [1, 2, 3]
    deletePath(arr, '/1')
    expect(arr).toEqual([1, 3])
  })

  it('should throw on non-existent paths', () => {
    const obj: Record<string, unknown> = { foo: { bar: 1 } }
    expect(() => deletePath(obj, '/foo/baz')).toThrow(PatchError)
  })

  it('should not throw on non-existent paths if strict is false', () => {
    const obj: Record<string, unknown> = { foo: { bar: 1 } }
    expect(() => deletePath(obj, '/foo/baz', false)).not.toThrow()
  })
})

describe('PatchError', () => {
  it('should have correct name and code', () => {
    const error = new PatchError('Test message', 'TEST_CODE')
    expect(error.name).toBe('PatchError')
    expect(error.code).toBe('TEST_CODE')
    expect(error.message).toBe('Test message')
  })

  it('should be instanceof Error', () => {
    const error = new PatchError('Test message', 'TEST_CODE')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(PatchError)
  })

  it('should have all error codes', () => {
    const codes = [
      'INVALID_PATH',
      'INVALID_INDEX',
      'PATH_NOT_FOUND',
      'PATH_EXISTS',
      'TEST_FAILED',
      'INVALID_OPERATION',
    ]
    for (const code of codes) {
      const error = new PatchError('Message', code)
      expect(error.code).toBe(code)
    }
  })
})

describe('own JSON member reads', () => {
  const document = { arr: [10], s: 'abc', n: null, own: { toString: 7, length: 8 } }
  const missing = ['/toString', '/arr/length', '/arr/1', '/s/length', '/s/0', '/n/x']

  it.each(missing)('does not read %s', (path) => {
    expect(getPath(document, path)).toBeUndefined()
    for (const op of ['test', 'replace', 'remove', 'copy', 'move'] as const) {
      const data = structuredClone(document)
      const patch =
        op === 'copy' || op === 'move'
          ? { op, from: path, path: '/destination' }
          : { op, path, value: 0 }
      expect(() => applyPatches(data, [patch])).toThrow(
        expect.objectContaining({ code: 'PATH_NOT_FOUND' }),
      )
      expect(data).toEqual(document)
    }
  })

  it('keeps own object members and array indices readable', () => {
    expect(getPath(document, '/own/toString')).toBe(7)
    expect(getPath(document, '/own/length')).toBe(8)
    expect(getPath(document, '/arr/0')).toBe(10)
    expect(getPath(document, '/n')).toBeNull()
    expect(getPath(document, '')).toBe(document)
    expect(getPath({ arr: [10] }, '/arr/00')).toBeUndefined()
  })

  it('does not traverse inherited or primitive members for writes or deletes', () => {
    for (const path of ['/toString/x', '/arr/length/x', '/s/0/x']) {
      expect(() => setPath(structuredClone(document), path, 1)).toThrow(
        expect.objectContaining({ code: 'PATH_NOT_FOUND' }),
      )
      expect(() => deletePath(structuredClone(document), path)).toThrow(
        expect.objectContaining({ code: 'PATH_NOT_FOUND' }),
      )
      expect(() => deletePath(structuredClone(document), path, false)).not.toThrow()
    }
  })

  it('ignores absent copy and move sources in non-strict mode', () => {
    for (const from of missing) {
      for (const op of ['copy', 'move'] as const) {
        const data = structuredClone(document)
        applyPatches(data, [{ op, from, path: '/destination' }], false)
        expect(data).toEqual(document)
      }
    }
  })
})
