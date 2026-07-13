# log — setup() double-configuration guard + first tests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** qa
**Mode:** tasks
**Spec:** [2026-07-13-log-setup-guard-design.md](../specs/2026-07-13-log-setup-guard-design.md)
**Branch:** `fix/log-setup-guard`

**Goal:** Make `@sozai/log`'s `setup()` idempotent instead of crashing when logging is already configured, export a `reset()` escape hatch, and give the package its first test suite.

**Architecture:** `setup()` gains a guard on logtape's `getConfig()`: if logging is already configured it logs an `error` record on the `['sozai', 'log']` logger and returns without reconfiguring (first call wins). `reset()` wraps logtape's `resetSync()` — it is both the escape hatch for intentional reconfiguration (`reset()` then `setup(config)`) and the mechanism tests need to clear logtape's global state between cases. The package has no test directory today, so vitest scaffolding lands alongside the first tests.

**Tech Stack:** TypeScript, `@logtape/logtape` v2, vitest, biome, changesets.

## Global Constraints

- Package under change: `packages/log`. Do not touch other packages.
- Conventions (`kigu:conventions`): `type` not `interface`; `Array<T>` not `T[]`; never `any`; ES `#fields`, never `private`/`readonly` in classes. Never edit `lib/` (generated).
- Code style is enforced by biome: single quotes, no semicolons, 2-space indent, 100-col. Match `packages/log/src/index.ts`.
- **This machine has an `rtk` shim that intercepts `pnpm run <script>` and `pnpm exec <bin>` and fails with a bogus `Cannot use 'in' operator to search for 'integrity' in undefined`.** Always call binaries directly from the workspace root's `node_modules/.bin`. The repo's `.githooks/pre-commit` runs `pnpm biome check`, so it hits the same shim — **commit with `git commit --no-verify`, and run lint + types + unit tests by hand first** (commands given in each task).
- `vitest` is not a dependency of any package; it resolves from the workspace root's `@kigu/dev`. Add no dependency.
- `turbo.json` already registers the `test:unit` task. No change needed there.

**Command reference** (run from repo root `/Users/paul/dev/yulsi/sozai`):

```bash
# Unit tests
cd packages/log && ../../node_modules/.bin/vitest run; cd ../..
# Type check (tests included)
cd packages/log && ../../node_modules/.bin/tsc --noEmit --skipLibCheck -p tsconfig.test.json; cd ../..
# Lint + format
./node_modules/.bin/biome check --write ./packages/log
```

---

### Task 1: Test infrastructure and `reset()`

Adds the vitest scaffolding the package lacks, and the one export every later test depends on. `reset()` must land first: logtape's configuration is process-global, so without it the first test to call `setup()` would leave every later test on the already-configured path.

**Files:**
- Create: `packages/log/tsconfig.test.json`
- Create: `packages/log/test/index.test.ts`
- Modify: `packages/log/package.json` (scripts block)
- Modify: `packages/log/src/index.ts` (imports on line 2; new `reset` export)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `reset(): void` — exported from `@sozai/log`, clears logtape's global configuration.
  - `packages/log/test/index.test.ts` — the single test file all later tasks extend.

- [ ] **Step 1: Create the test tsconfig**

Copy the sibling pattern from `packages/result/tsconfig.test.json`. Create `packages/log/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node"],
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["./src/**/*", "./test/**/*"]
}
```

- [ ] **Step 2: Wire up the package scripts**

In `packages/log/package.json`, the `scripts` block currently ends with `"test:types": "tsc --noEmit --skipLibCheck"` and `"test": "pnpm run test:types"`. Replace those two lines so the block reads:

```json
    "test:types": "tsc --noEmit --skipLibCheck -p tsconfig.test.json",
    "test:unit": "vitest run",
    "test": "pnpm run test:types && pnpm run test:unit",
```

Leave `build:clean`, `build:js`, `build:types` and `prepublishOnly` untouched.

- [ ] **Step 3: Write the failing test**

Create `packages/log/test/index.test.ts`:

```ts
import { getConfig } from '@logtape/logtape'
import { beforeEach, describe, expect, test } from 'vitest'

import { getDefaultConfig, reset, setup } from '../src/index.js'

describe('reset', () => {
  beforeEach(() => {
    reset()
  })

  test('clears the configuration', () => {
    setup()
    expect(getConfig()).not.toBeNull()
    reset()
    expect(getConfig()).toBeNull()
  })

  test('allows setup() to configure again', () => {
    setup()
    reset()
    setup(getDefaultConfig())
    expect(getConfig()).not.toBeNull()
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run:

```bash
cd packages/log && ../../node_modules/.bin/vitest run; cd ../..
```

Expected: FAIL — `reset` is not exported from `../src/index.js` (vitest reports `SyntaxError: The requested module '../src/index.js' does not provide an export named 'reset'`).

- [ ] **Step 5: Implement `reset()`**

In `packages/log/src/index.ts`, extend the logtape import on line 2 and add the export. The import becomes:

```ts
import {
  configureSync,
  getConsoleSink,
  getLogger as logtape,
  resetSync,
} from '@logtape/logtape'
```

And append to the end of the file:

```ts
/**
 * Clear the logging configuration, so `setup()` can configure it again.
 *
 * Both an escape hatch for intentional reconfiguration and the way test suites
 * clear logtape's process-global state between cases.
 */
export function reset(): void {
  resetSync()
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run:

```bash
cd packages/log && ../../node_modules/.bin/vitest run; cd ../..
```

Expected: PASS — 2 passed.

- [ ] **Step 7: Type check and lint**

Run:

```bash
cd packages/log && ../../node_modules/.bin/tsc --noEmit --skipLibCheck -p tsconfig.test.json; cd ../..
./node_modules/.bin/biome check --write ./packages/log
```

Expected: tsc prints nothing (exit 0); biome reports no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/log/package.json packages/log/tsconfig.test.json packages/log/src/index.ts packages/log/test/index.test.ts
git commit --no-verify -m "test(log): add vitest scaffolding and export reset()"
```

---

### Task 2: `setup()` double-configuration guard

The freeze-blocker itself. Today a second `setup()` call reaches `configureSync`, which throws `ConfigError` — two independent consumers each calling `setup()` crash the process. After this task the second call is a no-op that logs an `error` record on the already-installed sinks.

**Files:**
- Modify: `packages/log/src/index.ts:29-31` (the `setup` function) and the logtape import
- Modify: `packages/log/test/index.test.ts`

**Interfaces:**
- Consumes: `reset(): void` from Task 1.
- Produces:
  - `setup(maybeConfig?: Config<string, string>): void` — unchanged signature, now idempotent. No return value, no `force` option.
  - `memoryConfig(records: Array<LogRecord>): Config<string, string>` — test-file-local helper (not exported from the package) that Task 3 also uses. Routes the `['sozai']` and `['test']` categories at `debug` level into an in-memory array.

- [ ] **Step 1: Write the failing tests**

Add the helper and the suite to `packages/log/test/index.test.ts`. The full file after this step:

```ts
import type { Config, LogRecord } from '@logtape/logtape'
import { getConfig } from '@logtape/logtape'
import { beforeEach, describe, expect, test } from 'vitest'

import { getDefaultConfig, reset, setup } from '../src/index.js'

// Routes both the package's own category and a `test` category into `records`, at
// `debug` so every level is captured. The default config only routes `sozai` at
// `error`, which would drop most records under test.
function memoryConfig(records: Array<LogRecord>): Config<string, string> {
  return {
    sinks: {
      memory: (record: LogRecord) => {
        records.push(record)
      },
    },
    loggers: [
      { category: ['sozai'], lowestLevel: 'debug', sinks: ['memory'] },
      { category: ['test'], lowestLevel: 'debug', sinks: ['memory'] },
    ],
  }
}

describe('reset', () => {
  beforeEach(() => {
    reset()
  })

  test('clears the configuration', () => {
    setup()
    expect(getConfig()).not.toBeNull()
    reset()
    expect(getConfig()).toBeNull()
  })

  test('allows setup() to configure again', () => {
    setup()
    reset()
    setup(getDefaultConfig())
    expect(getConfig()).not.toBeNull()
  })
})

describe('setup', () => {
  beforeEach(() => {
    reset()
  })

  test('applies the default configuration when called with no arguments', () => {
    setup()
    expect(getConfig()).not.toBeNull()
  })

  test('applies the given configuration', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    expect(getConfig()?.sinks).toHaveProperty('memory')
  })

  test('does not throw when called twice', () => {
    setup()
    expect(() => {
      setup()
    }).not.toThrow()
  })

  test('keeps the first configuration when called twice', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    setup(getDefaultConfig())
    expect(getConfig()?.sinks).toHaveProperty('memory')
    expect(getConfig()?.sinks).not.toHaveProperty('console')
  })

  test('logs an error on the already-configured logger when called twice', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    setup()
    expect(records).toHaveLength(1)
    expect(records[0].level).toBe('error')
    expect(records[0].category).toEqual(['sozai', 'log'])
    expect(records[0].rawMessage).toBe('Logging already configured, setup() call ignored')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd packages/log && ../../node_modules/.bin/vitest run; cd ../..
```

Expected: FAIL — the `reset` suite still passes; the four `setup` double-call tests fail. `does not throw when called twice` fails with logtape's `ConfigError: Already configured; if you want to reset, call reset() first.`

- [ ] **Step 3: Implement the guard**

In `packages/log/src/index.ts`, add `getConfig` to the logtape import so line 2's import reads:

```ts
import {
  configureSync,
  getConfig,
  getConsoleSink,
  getLogger as logtape,
  resetSync,
} from '@logtape/logtape'
```

Then replace the `setup` function (lines 29-31) with:

```ts
/**
 * Configure logging, using the default configuration if none is given.
 *
 * The first call wins: if logging is already configured, this logs an error and
 * returns without reconfiguring, so that independent consumers each calling
 * `setup()` cannot crash the process. Use `reset()` to reconfigure deliberately.
 */
export function setup(maybeConfig?: Config<string, string>): void {
  if (getConfig() != null) {
    getSozaiLogger('log').error('Logging already configured, setup() call ignored')
    return
  }
  configureSync(maybeConfig ?? getDefaultConfig())
}
```

The `error()` call is safe precisely because the guard fired: logtape is configured, so the record reaches the sinks the first caller installed. Under `getDefaultConfig()` the `['sozai']` category is routed at `error`, so it surfaces. If an application's config does not route `sozai` at all, the record is dropped — best-effort notification, by design.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd packages/log && ../../node_modules/.bin/vitest run; cd ../..
```

Expected: PASS — 7 passed.

- [ ] **Step 5: Type check and lint**

Run:

```bash
cd packages/log && ../../node_modules/.bin/tsc --noEmit --skipLibCheck -p tsconfig.test.json; cd ../..
./node_modules/.bin/biome check --write ./packages/log
```

Expected: tsc prints nothing (exit 0); biome reports no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/log/src/index.ts packages/log/test/index.test.ts
git commit --no-verify -m "fix(log): make setup() idempotent instead of throwing on double configuration"
```

---

### Task 3: Cover the remaining exports, and the changeset

`getLogger`, `getSozaiLogger` and `getDefaultConfig` have never been tested. They are unchanged by this work, but the package's first test suite should not leave them bare — and `getSozaiLogger` is now on the guard's error path, so its category matters.

**Files:**
- Modify: `packages/log/test/index.test.ts`
- Create: `.changeset/log-setup-guard.md`

**Interfaces:**
- Consumes: `reset(): void` (Task 1); `memoryConfig(records: Array<LogRecord>): Config<string, string>` (Task 2, defined at the top of the test file).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Append these three suites to `packages/log/test/index.test.ts`, after the existing `setup` suite. Also add `vi` to the vitest import (`import { beforeEach, describe, expect, test, vi } from 'vitest'`) and `getLogger`, `getSozaiLogger` to the `../src/index.js` import.

```ts
describe('getLogger', () => {
  beforeEach(() => {
    reset()
  })

  test('takes a category as a string', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    getLogger('test').info('hello')
    expect(records).toHaveLength(1)
    expect(records[0].category).toEqual(['test'])
    expect(records[0].rawMessage).toBe('hello')
  })

  test('takes a category as an array', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    getLogger(['test', 'nested']).info('hello')
    expect(records[0].category).toEqual(['test', 'nested'])
  })

  test('attaches the given properties to records', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    getLogger('test', { requestID: 'abc' }).info('hello')
    expect(records[0].properties).toMatchObject({ requestID: 'abc' })
  })
})

describe('getSozaiLogger', () => {
  beforeEach(() => {
    reset()
  })

  test('namespaces the category under sozai', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    getSozaiLogger('otel').info('hello')
    expect(records[0].category).toEqual(['sozai', 'otel'])
  })

  test('attaches the given properties to records', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    getSozaiLogger('otel', { traceID: 'abc' }).info('hello')
    expect(records[0].properties).toMatchObject({ traceID: 'abc' })
  })
})

describe('getDefaultConfig', () => {
  beforeEach(() => {
    reset()
  })

  test('routes the sozai and logtape meta categories to a console sink at error level', () => {
    const config = getDefaultConfig()
    expect(Object.keys(config.sinks)).toEqual(['console'])
    expect(config.loggers).toEqual([
      { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: ['console'] },
      { category: ['sozai'], lowestLevel: 'error', sinks: ['console'] },
    ])
  })

  test('passes the sink options through to the console sink', () => {
    const error = vi.fn()
    const fakeConsole = { error } as unknown as Console
    setup(getDefaultConfig({ console: fakeConsole }))
    getSozaiLogger('test').error('boom')
    expect(error).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run the tests**

There is no red-green cycle in this task, and no implementation step: `getLogger`, `getSozaiLogger` and `getDefaultConfig` already exist and are not being changed. These tests characterise current behaviour, so they must pass on the first run.

Run:

```bash
cd packages/log && ../../node_modules/.bin/vitest run; cd ../..
```

Expected: PASS — 14 passed.

If one fails, fix the *test* to match the real behaviour (and say so in the commit) — do not change `src/index.ts` to satisfy it. Two known-shaky assertions: `config.loggers` deep equality (switch to `toMatchObject` if logtape normalises the shape), and the fake `Console` (widen `fakeConsole` with the other methods logtape's `levelMap` names — `debug`, `info`, `warn`, `trace` — if logtape calls one of them). A failure that is *not* one of those two is a real finding about the package — report it rather than papering over it.

- [ ] **Step 3: Write the changeset**

Create `.changeset/log-setup-guard.md`:

```markdown
---
"@sozai/log": patch
---

`setup()` no longer throws when logging is already configured.

Previously `setup()` called logtape's `configureSync` unguarded, which throws `ConfigError` on a second call — two independent consumers each calling `setup()` crashed the process. The first call now wins: a later call logs an `error` record on the `['sozai', 'log']` logger (reaching whatever sinks the first caller installed) and returns without reconfiguring.

Also adds `reset()`, which wraps logtape's `resetSync()`. It is the escape hatch for deliberate reconfiguration — `reset()` then `setup(config)` — and the way test suites clear logtape's process-global state between cases.

This is the package's first release with tests.
```

- [ ] **Step 4: Type check and lint**

Run:

```bash
cd packages/log && ../../node_modules/.bin/tsc --noEmit --skipLibCheck -p tsconfig.test.json; cd ../..
./node_modules/.bin/biome check --write ./packages/log
```

Expected: tsc prints nothing (exit 0); biome reports no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/log/test/index.test.ts .changeset/log-setup-guard.md
git commit --no-verify -m "test(log): cover getLogger, getSozaiLogger and getDefaultConfig"
```

---

## Done when

- `cd packages/log && ../../node_modules/.bin/vitest run` — 14 passed.
- `cd packages/log && ../../node_modules/.bin/tsc --noEmit --skipLibCheck -p tsconfig.test.json` — exit 0.
- `./node_modules/.bin/biome check ./packages/log` — no errors.
- `.changeset/log-setup-guard.md` exists.
- `docs/agents/plans/next/log-setup-guard.md` is deleted (its content now lives in the spec) — do this in the `completing` stage, not during execution.
