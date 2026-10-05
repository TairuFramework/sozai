import { describe, expect, test } from 'vitest'

import { renderLogMessage } from '../src/index.js'

function renderParts(message: Array<unknown>): string {
  return renderLogMessage({ rawMessage: Object.assign([], { raw: [] }), message })
}

describe('renderLogMessage()', () => {
  test('prefers raw method-call messages, including empty strings', () => {
    expect(renderLogMessage({ rawMessage: 'hello {name}', message: ['hello ', 'Ada'] })).toBe(
      'hello {name}',
    )
    expect(renderLogMessage({ rawMessage: '', message: ['ignored'] })).toBe('')
  })

  test('renders tagged-template values without quoting strings', () => {
    expect(renderParts(['hello ', 'Ada', ': ', { count: 2 }, '!'])).toBe('hello Ada: {"count":2}!')
    expect(renderParts([12, 12, null, null])).toBe('1212nullnull')
  })

  test('keeps values for which JSON.stringify returns undefined', () => {
    const fn = () => 1
    expect(renderParts(['', undefined, '/', Symbol('s'), '/', fn])).toBe(
      `undefined/Symbol(s)/${String(fn)}`,
    )
  })

  test('falls back when JSON.stringify throws', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const throwing = {
      toJSON() {
        throw new Error('bad JSON')
      },

      toString() {
        return 'visible'
      },
    }
    expect(renderParts(['', 1n, '/', circular, '/', throwing])).toBe('1/[object Object]/visible')
  })

  test('uses the final marker when string conversion also throws', () => {
    const hostile = {
      [Symbol.toPrimitive]() {
        throw new Error('bad string')
      },

      toJSON() {
        throw new Error('bad JSON')
      },
    }
    expect(renderParts(['', hostile, '/', Object.create(null)])).toBe('[unrenderable]/{}')
    expect(renderParts([Object.create(null)])).toBe('[unrenderable]')
  })

  test('guards record access and message traversal', () => {
    const record = {
      get rawMessage(): string {
        throw new Error('bad record')
      },

      message: [],
    }
    expect(renderLogMessage(record)).toBe('[unrenderable]')
  })
})
