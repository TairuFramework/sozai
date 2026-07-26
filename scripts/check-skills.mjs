#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'plugins/sozai/skills'
const CAP = 120
const failures = []

const realPackages = new Set(
  readdirSync('packages').map(
    (d) => JSON.parse(readFileSync(join('packages', d, 'package.json'), 'utf8')).name,
  ),
)

const mdFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? mdFiles(join(dir, e.name))
      : e.name.endsWith('.md')
        ? [join(dir, e.name)]
        : [],
  )

if (!existsSync(ROOT)) {
  console.error(`missing ${ROOT}`)
  process.exit(1)
}

const skills = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)

for (const file of mdFiles(ROOT)) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n').length
  if (lines > CAP) failures.push(`${file}: ${lines} lines, cap is ${CAP}`)
  const outward = text.match(/\/(enkaku|kokuin|kumiai):[a-z-]+/g)
  if (outward) failures.push(`${file}: outward reference ${[...new Set(outward)].join(', ')}`)
  for (const named of new Set(text.match(/@sozai\/[a-z0-9-]+/g) ?? [])) {
    if (!realPackages.has(named)) failures.push(`${file}: no such package ${named}`)
  }
}

for (const skill of skills) {
  const file = join(ROOT, skill, 'SKILL.md')
  if (!existsSync(file)) {
    failures.push(`${file}: missing`)
    continue
  }
  const text = readFileSync(file, 'utf8')
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!fm) {
    failures.push(`${file}: no frontmatter`)
    continue
  }
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim()
  if (name !== skill) failures.push(`${file}: name is "${name}", expected "${skill}"`)
  if (!fm[1].match(/^description:\s*\S/m)) failures.push(`${file}: no description`)
  const body = text.slice(fm[0].length)
  if (/^```/m.test(body)) failures.push(`${file}: contains a code block`)
  for (const [, target] of body.matchAll(/`(reference\/[a-z0-9-]+\.md)`/g)) {
    if (!existsSync(join(ROOT, skill, target))) failures.push(`${file}: dangling pointer ${target}`)
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`)
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}
console.log(`PASS ${mdFiles(ROOT).length} file(s), ${skills.length} skill(s)`)
