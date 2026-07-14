import { describe, expect, test } from 'vitest'

import { formatTracestate, parseTracestate } from '../src/tracestate.js'

describe('formatTracestate', () => {
  test('formats a single member', () => {
    expect(formatTracestate([{ key: 'rojo', value: '00f067aa0ba902b7' }])).toBe(
      'rojo=00f067aa0ba902b7',
    )
  })

  test('formats multiple members preserving order', () => {
    expect(
      formatTracestate([
        { key: 'rojo', value: '00f067aa0ba902b7' },
        { key: 'congo', value: 't61rcWkgMzE' },
      ]),
    ).toBe('rojo=00f067aa0ba902b7,congo=t61rcWkgMzE')
  })

  test('supports multi-tenant @ keys', () => {
    expect(formatTracestate([{ key: 'fw529a3039@dt', value: 'foo' }])).toBe('fw529a3039@dt=foo')
  })

  test('drops members with invalid key or value', () => {
    expect(
      formatTracestate([
        { key: 'OK', value: 'bad' },
        { key: 'good', value: 'has,comma' },
        { key: 'keep', value: 'fine' },
      ]),
    ).toBe('keep=fine')
  })

  test('caps at 32 entries', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, value: `v${i}` }))
    const result = formatTracestate(entries)
    expect(result.split(',')).toHaveLength(32)
  })

  test('drops a value ending in a space', () => {
    expect(
      formatTracestate([
        { key: 'k', value: 'trailing ' },
        { key: 'keep', value: 'ok' },
      ]),
    ).toBe('keep=ok')
  })

  test('drops duplicate keys, keeping the first occurrence', () => {
    const result = formatTracestate([
      { key: 'vendor', value: 'first' },
      { key: 'other', value: 'kept' },
      { key: 'vendor', value: 'second' },
    ])
    expect(result).toBe('vendor=first,other=kept')
  })

  test('dedupes before applying the 32-entry cap', () => {
    // 40 duplicates of one key collapse to a single entry rather than
    // tripping the cap and emitting a burst of drop warnings.
    const entries = Array.from({ length: 40 }, (_, index) => ({
      key: 'vendor',
      value: `value${index}`,
    }))
    expect(formatTracestate(entries)).toBe('vendor=value0')
  })

  test('round-trips with parseTracestate', () => {
    const header = 'vendor=first,other=kept'
    expect(formatTracestate(parseTracestate(header))).toBe(header)
  })
})

describe('parseTracestate', () => {
  test('parses a valid header', () => {
    expect(parseTracestate('rojo=00f067aa0ba902b7,congo=t61rcWkgMzE')).toEqual([
      { key: 'rojo', value: '00f067aa0ba902b7' },
      { key: 'congo', value: 't61rcWkgMzE' },
    ])
  })

  test('trims optional whitespace around members', () => {
    expect(parseTracestate('rojo=1, congo=2')).toEqual([
      { key: 'rojo', value: '1' },
      { key: 'congo', value: '2' },
    ])
  })

  test('drops malformed members, never throws', () => {
    expect(parseTracestate('rojo=1,garbage,=novalue,nokey,good=2')).toEqual([
      { key: 'rojo', value: '1' },
      { key: 'good', value: '2' },
    ])
  })

  test('keeps first occurrence of duplicate keys', () => {
    expect(parseTracestate('dup=first,dup=second')).toEqual([{ key: 'dup', value: 'first' }])
  })

  test('caps at 32 entries', () => {
    const header = Array.from({ length: 40 }, (_, i) => `k${i}=v${i}`).join(',')
    expect(parseTracestate(header)).toHaveLength(32)
  })

  test('returns empty array for empty header', () => {
    expect(parseTracestate('')).toEqual([])
  })
})

describe('tracestate round-trip', () => {
  test('parse(format(x)) reproduces valid input', () => {
    const entries = [
      { key: 'rojo', value: '00f067aa0ba902b7' },
      { key: 'congo', value: 't61rcWkgMzE' },
    ]
    expect(parseTracestate(formatTracestate(entries))).toEqual(entries)
  })
})
