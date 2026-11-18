import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

import { checkGolden, type GoldenCase } from '../../../scripts/golden.ts'
import { applyPatches, PatchError, type PatchOperation } from '../src/index.js'

const file = join(dirname(fileURLToPath(import.meta.url)), 'golden/patch.json')
type Fixture = {
  name: string
  document: Record<string, unknown>
  patches: Array<PatchOperation>
  error?: string
}

function patchCases(): Array<GoldenCase> {
  const fixtures: Array<Fixture> = [
    { name: 'add-property', document: { a: 1 }, patches: [{ op: 'add', path: '/b', value: 2 }] },
    {
      name: 'add-array-insert',
      document: { a: [1, 3] },
      patches: [{ op: 'add', path: '/a/1', value: 2 }],
    },
    {
      name: 'add-array-append',
      document: { a: [1] },
      patches: [{ op: 'add', path: '/a/-', value: 2 }],
    },
    { name: 'remove-property', document: { a: 1, b: 2 }, patches: [{ op: 'remove', path: '/a' }] },
    { name: 'remove-array', document: { a: [1, 2, 3] }, patches: [{ op: 'remove', path: '/a/1' }] },
    {
      name: 'replace',
      document: { a: 1 },
      patches: [{ op: 'replace', path: '/a', value: { b: 2 } }],
    },
    {
      name: 'move',
      document: { a: { x: 1 }, b: {} },
      patches: [{ op: 'move', from: '/a', path: '/b/c' }],
    },
    {
      name: 'move-array',
      document: { a: [1, 2, 3] },
      patches: [{ op: 'move', from: '/a/0', path: '/a/2' }],
    },
    {
      name: 'copy',
      document: { a: { x: 1 } },
      patches: [
        { op: 'copy', from: '/a', path: '/b' },
        { op: 'replace', path: '/b/x', value: 2 },
      ],
    },
    {
      name: 'test',
      document: { a: { x: [1, true, null] } },
      patches: [{ op: 'test', path: '/a', value: { x: [1, true, null] } }],
    },
    { name: 'set-create', document: {}, patches: [{ op: 'set', path: '/a', value: 1 }] },
    {
      name: 'set-replace',
      document: { a: [1, 2] },
      patches: [{ op: 'set', path: '/a/0', value: 3 }],
    },
    { name: 'set-append', document: { a: [1] }, patches: [{ op: 'set', path: '/a/-', value: 2 }] },
    {
      name: 'escaped-pointer',
      document: { 'a/b': { '~': 1 } },
      patches: [{ op: 'replace', path: '/a~1b/~0', value: 2 }],
    },
    {
      name: 'missing-path',
      document: { a: 1 },
      patches: [{ op: 'remove', path: '/missing' }],
      error: 'PATH_NOT_FOUND',
    },
    {
      name: 'failed-test-atomic',
      document: { a: 1 },
      patches: [
        { op: 'replace', path: '/a', value: 2 },
        { op: 'test', path: '/a', value: 1 },
      ],
      error: 'TEST_FAILED',
    },
    {
      name: 'remove-array-dash',
      document: { a: [1] },
      patches: [{ op: 'remove', path: '/a/-' }],
      error: 'PATH_NOT_FOUND',
    },
    {
      name: 'replace-array-dash',
      document: { a: [1] },
      patches: [{ op: 'replace', path: '/a/-', value: 2 }],
      error: 'PATH_NOT_FOUND',
    },
    {
      name: 'test-array-dash',
      document: { a: [1] },
      patches: [{ op: 'test', path: '/a/-', value: 1 }],
      error: 'PATH_NOT_FOUND',
    },
  ]
  return fixtures.map(({ name, document, patches, error: expectedError }) => {
    const result = structuredClone(document)
    let failure: { error: string; code: string } | undefined
    try {
      applyPatches(result, patches)
    } catch (error) {
      if (!(error instanceof PatchError)) throw error
      failure = { error: error.name, code: error.code }
    }
    expect(failure?.code, name).toBe(expectedError)
    if (failure) expect(result, `${name}: atomic failure`).toEqual(document)
    return {
      name,
      input: { document, patches },
      expected: failure ? { ...failure, document: result } : { document: result },
    }
  })
}

test('golden: JSON Patch', () => checkGolden(file, patchCases()))
test('golden: JSON Patch does not write without UPDATE_GOLDEN', () => {
  if (process.env.UPDATE_GOLDEN === '1') return
  const before = statSync(file).mtimeMs
  checkGolden(file, patchCases())
  expect(statSync(file).mtimeMs).toBe(before)
})
