import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { canonicalize } from '../src/index.js'

const VECTORS_DIR = join(import.meta.dirname, 'vectors')
const NAMES = ['arrays', 'french', 'structures', 'unicode', 'values', 'weird']

describe('RFC 8785 official test vectors', () => {
  test.each(NAMES)('%s', (name) => {
    const input = readFileSync(join(VECTORS_DIR, 'input', `${name}.json`), 'utf8')
    const expected = readFileSync(join(VECTORS_DIR, 'output', `${name}.json`), 'utf8')
    expect(canonicalize(JSON.parse(input))).toBe(expected)
  })
})
