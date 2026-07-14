import { createTraceState } from '@opentelemetry/api'
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

  test('caps the serialized header at 512 characters, dropping whole trailing members', () => {
    // Three ~252-char members: the first two fit within 512 (252 + 1 + 252 =
    // 505), the third does not (505 + 1 + 252 = 758) and must be dropped
    // entirely, not truncated mid-value.
    const entries = [
      { key: 'a', value: 'x'.repeat(250) },
      { key: 'b', value: 'x'.repeat(250) },
      { key: 'c', value: 'x'.repeat(250) },
    ]
    const header = formatTracestate(entries)

    expect(header.length).toBeLessThanOrEqual(512)
    expect(header).toContain('a=')
    expect(header).toContain('b=')
    expect(header).not.toContain('c=')
    // No half-member: every member present is a complete, valid `key=value`.
    for (const member of header.split(',')) {
      expect(member).toMatch(/^[a-z]=x+$/)
    }

    // This is the actual bug (W3C §3.3.3 / OTel's own 512-char limit): a
    // tracestate header over 512 chars makes OTel's TraceStateImpl._parse
    // bail out early and leave the trace state empty, so serialize() would
    // yield '' and injectW3CTraceContext would omit tracestate entirely.
    // Verify the truncated header survives that round-trip non-empty.
    expect(createTraceState(header).serialize()).not.toBe('')
    expect(createTraceState(header).serialize().length).toBeLessThanOrEqual(512)
  })

  test('truncates from the end: a member after one that alone exceeds 512 characters is also dropped', () => {
    // A key can be up to 256 chars and a value up to 256 chars, so a single
    // member can itself exceed the 512-char header cap. Truncation is "from
    // the end" of the sequence — once a member doesn't fit, it and everything
    // after it is dropped, even if a later member would fit on its own.
    const entries = [
      { key: 'a'.repeat(256), value: 'x'.repeat(256) },
      { key: 'keep', value: 'ok' },
    ]
    const header = formatTracestate(entries)
    expect(header).toBe('')
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
