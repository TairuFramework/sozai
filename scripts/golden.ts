import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { expect } from 'vitest'

export type GoldenCase = { name: string; input: unknown; expected: unknown }

export function checkGolden(path: string, cases: Array<GoldenCase>): void {
  const names = cases.map(({ name }) => name)
  expect(new Set(names).size, 'Duplicate generated case names').toBe(names.length)
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ version: 1, cases }, null, 2)}\n`)
    return
  }
  const golden = JSON.parse(readFileSync(path, 'utf8')) as {
    version: number
    cases: Array<GoldenCase>
  }
  expect(golden.version).toBe(1)
  expect(new Set(golden.cases.map(({ name }) => name)).size, 'Duplicate saved case names').toBe(
    golden.cases.length,
  )
  expect(golden.cases.map(({ name }) => name).sort()).toEqual(cases.map(({ name }) => name).sort())
  for (const item of cases) {
    expect(item, item.name).toEqual(golden.cases.find(({ name }) => name === item.name))
  }
}
