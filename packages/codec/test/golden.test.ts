import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'

import { checkGolden, type GoldenCase } from '../../../scripts/golden.ts'
import {
  canonicalStringify,
  decodeVarint,
  encodeVarint,
  fromB32,
  fromB64,
  fromB64U,
  toB32,
  toB64,
  toB64U,
} from '../src/index.js'

const dir = dirname(fileURLToPath(import.meta.url))

// All rows from https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B.
// IEEE 754 hex preserves negative zero and non-finite inputs across JSON readers.
const appendixB: Array<[string, string | null]> = [
  ['0000000000000000', '0'],
  ['8000000000000000', '0'],
  ['0000000000000001', '5e-324'],
  ['8000000000000001', '-5e-324'],
  ['7fefffffffffffff', '1.7976931348623157e+308'],
  ['ffefffffffffffff', '-1.7976931348623157e+308'],
  ['4340000000000000', '9007199254740992'],
  ['c340000000000000', '-9007199254740992'],
  ['4430000000000000', '295147905179352830000'],
  ['7fffffffffffffff', null],
  ['7ff0000000000000', null],
  ['44b52d02c7e14af5', '9.999999999999997e+22'],
  ['44b52d02c7e14af6', '1e+23'],
  ['44b52d02c7e14af7', '1.0000000000000001e+23'],
  ['444b1ae4d6e2ef4e', '999999999999999700000'],
  ['444b1ae4d6e2ef4f', '999999999999999900000'],
  ['444b1ae4d6e2ef50', '1e+21'],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
  ['3eb0c6f7a0b5ed8d', '0.000001'],
  ['41b3de4355555553', '333333333.3333332'],
  ['41b3de4355555554', '333333333.33333325'],
  ['41b3de4355555555', '333333333.3333333'],
  ['41b3de4355555556', '333333333.3333334'],
  ['41b3de4355555557', '333333333.33333343'],
  ['becbf647612f3696', '-0.0000033333333333333333'],
  ['43143ff3c1cb0959', '1424953923781206.2'],
]

function canonicalResult(value: unknown): unknown {
  try {
    return canonicalStringify(value)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return { error: error.name }
  }
}

function canonicalCases(): Array<GoldenCase> {
  const numbers = [...appendixB.map(([hex]) => hex), 'fff0000000000000'].map((hex) => ({
    name: `float64-${hex}`,
    input: { float64: hex },
    expected: canonicalResult(Buffer.from(hex, 'hex').readDoubleBE()),
  }))
  const values: Array<[string, unknown]> = [
    ['one-e21', 1e21],
    ['smallest-positive', 5e-324],
    ['floating-addition', 0.1 + 0.2],
    ['UTF-16-key-order', { '\ufb33': 1, '\ud83d\ude02': 2, a: 3 }],
    ['empty-objects-in-arrays', [{}, [{}, { b: {}, a: [] }]]],
    ['valid-surrogate-pairs', { '\ud800\udc00': '\udbff\udfff' }],
    ['string-escaping', '\u0000\b\t\n\f\r"\\/€'],
    ['literals', [null, true, false]],
    ['lone-high-surrogate', '\ud800'],
    ['lone-low-surrogate', '\udfff'],
    ['nested-lone-surrogate', { value: ['\ud800'] }],
    ['lone-high-property-name', { '\ud800': 1 }],
    ['lone-low-property-name', { '\udfff': 1 }],
  ]
  for (const [name, value] of values) {
    if (name.includes('lone-')) {
      expect(canonicalResult(value), name).toEqual({ error: 'TypeError' })
    }
  }
  return [
    ...numbers,
    ...values.map(([name, value]) => ({
      name,
      input: { value },
      expected: canonicalResult(value),
    })),
  ]
}

function codecCases(): Array<GoldenCase> {
  const cases: Array<GoldenCase> = []
  for (const length of [0, 1, 31, 32, 33]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 251) % 256)
    const hex = Buffer.from(bytes).toString('hex')
    const b64 = toB64(bytes)
    const b64u = toB64U(bytes)
    const b32 = toB32(bytes)
    cases.push({
      name: `bytes-${length}`,
      input: { hex },
      expected: {
        b64,
        b64u,
        b32,
        fromB64: Buffer.from(fromB64(b64)).toString('hex'),
        fromB64U: Buffer.from(fromB64U(b64u)).toString('hex'),
        fromB32: Buffer.from(fromB32(b32)).toString('hex'),
      },
    })
  }
  for (const value of [0, 127, 128, 16383, 16384, Number.MAX_SAFE_INTEGER]) {
    const encoded = encodeVarint(value)
    cases.push({
      name: `varint-${value}`,
      input: { value },
      expected: { hex: Buffer.from(encoded).toString('hex'), decoded: decodeVarint(encoded) },
    })
  }
  return cases
}

test('golden: canonical JSON', () =>
  checkGolden(join(dir, 'golden/canonical-json.json'), canonicalCases()))
test('golden: codecs', () => checkGolden(join(dir, 'golden/codecs.json'), codecCases()))
test('golden: does not write without UPDATE_GOLDEN', () => {
  if (process.env.UPDATE_GOLDEN === '1') return
  for (const [name, cases] of [
    ['canonical-json', canonicalCases()],
    ['codecs', codecCases()],
  ] as const) {
    const file = join(dir, `golden/${name}.json`)
    const before = statSync(file).mtimeMs
    checkGolden(file, cases)
    expect(statSync(file).mtimeMs).toBe(before)
  }
})

test('golden: RFC 8785 Appendix B independently matches every saved number', () => {
  const cases = JSON.parse(readFileSync(join(dir, 'golden/canonical-json.json'), 'utf8'))
    .cases as Array<GoldenCase>
  for (const [hex, expected] of appendixB) {
    expect(cases.find(({ name }) => name === `float64-${hex}`)?.expected, hex).toEqual(
      expected ?? { error: 'TypeError' },
    )
  }
})

test('golden helper compares by name and rejects changed, missing and duplicate cases without writing', () => {
  const temporary = mkdtempSync(join(dir, '.golden-helper-'))
  const file = join(temporary, 'nested/cases.json')
  const cases: Array<GoldenCase> = [
    { name: 'first', input: { value: 1 }, expected: '1' },
    { name: 'second', input: { value: 2 }, expected: '2' },
  ]
  try {
    vi.stubEnv('UPDATE_GOLDEN', '0')
    expect(() => checkGolden(file, cases)).toThrow(/ENOENT/)
    vi.stubEnv('UPDATE_GOLDEN', '1')
    checkGolden(file, cases)
    const saved = readFileSync(file, 'utf8')
    expect(saved).toBe(`${JSON.stringify({ version: 1, cases }, null, 2)}\n`)
    vi.stubEnv('UPDATE_GOLDEN', '0')
    const before = statSync(file).mtimeMs
    checkGolden(file, [...cases].reverse())
    expect(() =>
      checkGolden(file, [
        { name: 'first', input: { value: 1 }, expected: 'changed' },
        cases[1] as GoldenCase,
      ]),
    ).toThrow()
    expect(() => checkGolden(file, cases.slice(0, 1))).toThrow()
    expect(() =>
      checkGolden(file, [...cases, { name: 'extra', input: null, expected: null }]),
    ).toThrow()
    expect(() => checkGolden(file, [cases[0] as GoldenCase, cases[0] as GoldenCase])).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(saved)
    expect(statSync(file).mtimeMs).toBe(before)
  } finally {
    vi.unstubAllEnvs()
    rmSync(temporary, { recursive: true, force: true })
  }
})
