# otel W3C Trace Context Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks
**Spec:** [2026-07-14-otel-w3c-compliance-design.md](../specs/2026-07-14-otel-w3c-compliance-design.md)

**Goal:** Bring `@sozai/otel` into W3C Trace Context compliance by collapsing its two trace-context code paths into one validated path, and fix the three hygiene defects the audit found alongside them.

**Architecture:** A new internal module `src/span-context.ts` becomes the single authority for trace-ID/span-ID validation and remote `SpanContext` construction. `traceparent.ts` and `context.ts` both route through it. The custom `tid`/`sid` propagation path (`injectTraceContext`/`extractTraceContext`) is deleted rather than repaired — it is an unshipped second encoding of the same three values the W3C path already carries — and replaced by `injectW3CTraceContext`, the inject-side twin of the existing `extractW3CTraceContext`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@opentelemetry/api` 1.9, `@opentelemetry/api-logs` 0.220, `@logtape/logtape` 2.2 (via `@sozai/log`), vitest, biome, changesets.

## Global Constraints

- Follow the `kigu:conventions` skill. Specifically: `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID` in identifiers (`traceID`, not `traceId`) for *our* symbols — OTel's own `SpanContext` fields stay `traceId`/`spanId` because they are their API, not ours.
- Never edit `lib/` — it is generated.
- ESM: every relative import ends in `.js`.
- Run repo scripts as `pnpm exec vitest ...` / `pnpm exec biome ...`, or `rtk proxy pnpm run <script>`. A machine-level `rtk` shim hijacks bare `pnpm run <script>`.
- Package under change: `packages/otel` (`@sozai/otel` 0.2.0). One task also touches `packages/log` (`@sozai/log`).
- Working directory for all commands below: `packages/otel`, unless a path says otherwise.
- Do not commit until a task's tests pass. One commit per task.

## File Structure

| File | Responsibility |
|---|---|
| `src/semantic.ts` | **Modify.** Gains an internal `ZERO_SPAN_ID` beside the existing exported `ZERO_TRACE_ID`. |
| `src/span-context.ts` | **Create.** The single validation authority: `isValidTraceID`, `isValidSpanID`, `toRemoteSpanContext`. Not exported from the package index — internal. |
| `src/traceparent.ts` | **Modify.** `parseTraceparent` rejects all-zero IDs and version `ff`, tolerates future versions. `formatTraceparent` validates and returns `string \| undefined`. |
| `src/tracestate.ts` | **Modify.** `formatTracestate` dedupes keys before applying the 32-entry cap. |
| `src/context.ts` | **Modify.** `injectTraceContext`/`extractTraceContext` deleted; `injectW3CTraceContext` added; `extractW3CTraceContext` routes through `toRemoteSpanContext`. |
| `src/tracers.ts` | **Modify.** `createTracerFactory` takes an optional `version`; `setStatus(OK)` removed from both span wrappers; the no-op-span guard uses `isValidTraceID`. |
| `src/log-sink.ts` | **Modify.** Imports logtape's real `LogRecord`; exhaustive severity map; fixes the `TemplateStringsArray` body bug. |
| `src/index.ts` | **Modify.** Export surface follows the API delta. |
| `packages/log/src/index.ts` | **Modify.** Re-exports logtape's `LogRecord` type. |
| `docs/reference/observability.md` | **Modify.** Context-propagation table and "When to use" line. |

Tasks 2–6 are independent of each other and all depend only on Task 1.

---

### Task 1: Validation authority (`span-context.ts`)

**Files:**
- Modify: `src/semantic.ts`
- Create: `src/span-context.ts`
- Test: `test/span-context.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces — every later task depends on these:
  - `ZERO_SPAN_ID: string` from `./semantic.js` (internal; not added to `src/index.ts`)
  - `isValidTraceID(value: string): boolean`
  - `isValidSpanID(value: string): boolean`
  - `toRemoteSpanContext(data: TraceparentData, traceState?: TraceState): SpanContext | undefined`
  - `TraceparentData` keeps its current shape and home in `src/traceparent.ts`: `{ traceID: string; spanID: string; traceFlags: number }`. `span-context.ts` imports it with `import type`, so the import cycle between the two modules is erased at build time and never exists at runtime.

- [ ] **Step 1: Write the failing test**

Create `test/span-context.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { isValidSpanID, isValidTraceID, toRemoteSpanContext } from '../src/span-context.js'

describe('isValidTraceID', () => {
  test('accepts 32 lowercase hex characters', () => {
    expect(isValidTraceID('0af7651916cd43dd8448eb211c80319c')).toBe(true)
  })

  test('rejects the all-zero trace ID', () => {
    expect(isValidTraceID('00000000000000000000000000000000')).toBe(false)
  })

  test('rejects wrong lengths', () => {
    expect(isValidTraceID('0af7651916cd43dd8448eb211c80319')).toBe(false)
    expect(isValidTraceID('0af7651916cd43dd8448eb211c80319cc')).toBe(false)
    expect(isValidTraceID('')).toBe(false)
  })

  test('rejects uppercase hex and non-hex characters', () => {
    expect(isValidTraceID('0AF7651916CD43DD8448EB211C80319C')).toBe(false)
    expect(isValidTraceID('0af7651916cd43dd8448eb211c80319z')).toBe(false)
  })
})

describe('isValidSpanID', () => {
  test('accepts 16 lowercase hex characters', () => {
    expect(isValidSpanID('00f067aa0ba902b7')).toBe(true)
  })

  test('rejects the all-zero span ID', () => {
    expect(isValidSpanID('0000000000000000')).toBe(false)
  })

  test('rejects wrong lengths', () => {
    expect(isValidSpanID('00f067aa0ba902b')).toBe(false)
    expect(isValidSpanID('00f067aa0ba902b77')).toBe(false)
    expect(isValidSpanID('')).toBe(false)
  })

  test('rejects uppercase hex and non-hex characters', () => {
    expect(isValidSpanID('00F067AA0BA902B7')).toBe(false)
    expect(isValidSpanID('00f067aa0ba902bz')).toBe(false)
  })
})

describe('toRemoteSpanContext', () => {
  const valid = {
    traceID: '0af7651916cd43dd8448eb211c80319c',
    spanID: '00f067aa0ba902b7',
    traceFlags: 1,
  }

  test('builds a remote SpanContext from valid data', () => {
    expect(toRemoteSpanContext(valid)).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
      isRemote: true,
    })
  })

  test('preserves unsampled flags rather than forcing SAMPLED', () => {
    expect(toRemoteSpanContext({ ...valid, traceFlags: 0 })?.traceFlags).toBe(0)
  })

  test('returns undefined for an all-zero trace ID', () => {
    expect(
      toRemoteSpanContext({ ...valid, traceID: '00000000000000000000000000000000' }),
    ).toBeUndefined()
  })

  test('returns undefined for an all-zero span ID', () => {
    expect(toRemoteSpanContext({ ...valid, spanID: '0000000000000000' })).toBeUndefined()
  })

  test('returns undefined for a malformed ID', () => {
    expect(toRemoteSpanContext({ ...valid, traceID: 'garbage' })).toBeUndefined()
  })

  test('omits traceState when not given', () => {
    expect(toRemoteSpanContext(valid)).not.toHaveProperty('traceState')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/span-context.test.ts`
Expected: FAIL — `Failed to resolve import "../src/span-context.js"`.

- [ ] **Step 3: Add `ZERO_SPAN_ID` to `src/semantic.ts`**

Insert directly below the existing `ZERO_TRACE_ID` line, at the top of the file:

```ts
export const ZERO_TRACE_ID = '00000000000000000000000000000000'

/**
 * The all-zero span ID. W3C Trace Context declares it invalid, and OTel's no-op
 * spans carry it. Internal — not re-exported from the package index, because no
 * consumer has a use for it. `ZERO_TRACE_ID` is public only because it predates
 * this module.
 */
export const ZERO_SPAN_ID = '0000000000000000'
```

- [ ] **Step 4: Write `src/span-context.ts`**

```ts
import type { SpanContext, TraceState } from '@opentelemetry/api'

import { ZERO_SPAN_ID, ZERO_TRACE_ID } from './semantic.js'
import type { TraceparentData } from './traceparent.js'

const TRACE_ID_REGEX = /^[\da-f]{32}$/
const SPAN_ID_REGEX = /^[\da-f]{16}$/

/**
 * Whether `value` is a valid W3C trace ID: 32 lowercase hex characters, not all-zero.
 */
export function isValidTraceID(value: string): boolean {
  return TRACE_ID_REGEX.test(value) && value !== ZERO_TRACE_ID
}

/**
 * Whether `value` is a valid W3C span ID: 16 lowercase hex characters, not all-zero.
 */
export function isValidSpanID(value: string): boolean {
  return SPAN_ID_REGEX.test(value) && value !== ZERO_SPAN_ID
}

/**
 * Build a remote `SpanContext` from parsed traceparent data. Returns undefined when
 * either ID is invalid, so an unparseable or all-zero remote context can never become
 * a parent that SDKs attach real spans to.
 *
 * The single place in the package where a remote `SpanContext` is constructed.
 */
export function toRemoteSpanContext(
  data: TraceparentData,
  traceState?: TraceState,
): SpanContext | undefined {
  if (!isValidTraceID(data.traceID) || !isValidSpanID(data.spanID)) {
    return undefined
  }
  const spanContext: SpanContext = {
    traceId: data.traceID,
    spanId: data.spanID,
    traceFlags: data.traceFlags,
    isRemote: true,
  }
  if (traceState != null) {
    spanContext.traceState = traceState
  }
  return spanContext
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run test/span-context.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/semantic.ts src/span-context.ts test/span-context.test.ts
git commit -m "feat(otel): single authority for trace/span ID validation"
```

---

### Task 2: `traceparent.ts` — reject invalid IDs, tolerate future versions

**Files:**
- Modify: `src/traceparent.ts`
- Test: `test/traceparent.test.ts` (extend; existing tests stay)

**Interfaces:**
- Consumes: `isValidSpanID`, `isValidTraceID` from `./span-context.js` (Task 1).
- Produces:
  - `formatTraceparent(traceID: string, spanID: string, traceFlags: number): string | undefined` — **return type widened**. Task 4 relies on the `undefined` case.
  - `parseTraceparent(header: string): TraceparentData | undefined` — signature unchanged, behaviour tightened.
  - `TraceparentData` — unchanged.

**Note on the existing test file:** it already has a `returns undefined for unsupported version` case asserting `ff-...` is undefined. That assertion stays correct (the spec declares `ff` invalid), but its *name* becomes wrong once other versions are supported. Rename it as shown in Step 1.

- [ ] **Step 1: Write the failing tests**

In `test/traceparent.test.ts`, replace the whole file with:

```ts
import { describe, expect, test } from 'vitest'

import { formatTraceparent, parseTraceparent } from '../src/traceparent.js'

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const SPAN_ID = '00f067aa0ba902b7'

describe('formatTraceparent', () => {
  test('formats a traceparent header', () => {
    expect(formatTraceparent(TRACE_ID, SPAN_ID, 1)).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`)
  })

  test('formats with zero flags', () => {
    expect(formatTraceparent(TRACE_ID, SPAN_ID, 0)).toBe(`00-${TRACE_ID}-${SPAN_ID}-00`)
  })

  test('returns undefined for an all-zero trace ID', () => {
    expect(formatTraceparent('0'.repeat(32), SPAN_ID, 1)).toBeUndefined()
  })

  test('returns undefined for an all-zero span ID', () => {
    expect(formatTraceparent(TRACE_ID, '0'.repeat(16), 1)).toBeUndefined()
  })

  test('returns undefined for malformed IDs', () => {
    expect(formatTraceparent('short', SPAN_ID, 1)).toBeUndefined()
    expect(formatTraceparent(TRACE_ID, `${SPAN_ID}extra`, 1)).toBeUndefined()
    expect(formatTraceparent(TRACE_ID.toUpperCase(), SPAN_ID, 1)).toBeUndefined()
  })

  test('returns undefined for out-of-range flags rather than masking them', () => {
    // 256 & 0xff === 0, which would silently turn a sampled trace unsampled.
    expect(formatTraceparent(TRACE_ID, SPAN_ID, 256)).toBeUndefined()
    expect(formatTraceparent(TRACE_ID, SPAN_ID, -1)).toBeUndefined()
    expect(formatTraceparent(TRACE_ID, SPAN_ID, 1.5)).toBeUndefined()
    expect(formatTraceparent(TRACE_ID, SPAN_ID, Number.NaN)).toBeUndefined()
  })

  test('formats the maximum in-range flags', () => {
    expect(formatTraceparent(TRACE_ID, SPAN_ID, 255)).toBe(`00-${TRACE_ID}-${SPAN_ID}-ff`)
  })
})

describe('parseTraceparent', () => {
  test('parses a valid traceparent header', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`)).toEqual({
      traceID: TRACE_ID,
      spanID: SPAN_ID,
      traceFlags: 1,
    })
  })

  test('returns undefined for invalid format', () => {
    expect(parseTraceparent('invalid')).toBeUndefined()
    expect(parseTraceparent('')).toBeUndefined()
    expect(parseTraceparent(`00-short-${SPAN_ID}-01`)).toBeUndefined()
  })

  test('returns undefined for version ff, which the spec declares invalid', () => {
    expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeUndefined()
  })

  test('returns undefined for an all-zero trace ID', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN_ID}-01`)).toBeUndefined()
  })

  test('returns undefined for an all-zero span ID', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${'0'.repeat(16)}-01`)).toBeUndefined()
  })

  test('parses the first four fields of a future version', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-extra-fields`)).toEqual({
      traceID: TRACE_ID,
      spanID: SPAN_ID,
      traceFlags: 1,
    })
  })

  test('parses a future version with no trailing fields', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01`)).toEqual({
      traceID: TRACE_ID,
      spanID: SPAN_ID,
      traceFlags: 1,
    })
  })

  test('rejects a trailing field on version 00, which is malformed rather than future', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01-extra`)).toBeUndefined()
  })

  test('rejects a trailing dash with no content', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-`)).toBeUndefined()
  })

  test('preserves unknown future flag bits without interpreting them', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-ff`)?.traceFlags).toBe(255)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/traceparent.test.ts`
Expected: FAIL — several cases. Notably `returns undefined for an all-zero trace ID` (currently returns an object) and `parses the first four fields of a future version` (currently returns undefined).

- [ ] **Step 3: Rewrite `src/traceparent.ts`**

```ts
import { isValidSpanID, isValidTraceID } from './span-context.js'

export type TraceparentData = {
  traceID: string
  spanID: string
  traceFlags: number
}

// Four required fields, plus an optional trailing segment that only a future
// version may carry. The trailing segment must be non-empty, so a bare trailing
// dash stays malformed.
const TRACEPARENT_REGEX = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})(-.+)?$/

const MAX_TRACE_FLAGS = 0xff

/**
 * Format a W3C traceparent header value. Returns undefined when the IDs or flags
 * cannot produce a valid header, rather than emitting a malformed one — an omitted
 * header is the correct wire outcome, since no trace beats a corrupt trace.
 *
 * Out-of-range flags are rejected, not masked: `256 & 0xff` is `0`, which would
 * silently flip a sampled trace to unsampled.
 */
export function formatTraceparent(
  traceID: string,
  spanID: string,
  traceFlags: number,
): string | undefined {
  if (!isValidTraceID(traceID) || !isValidSpanID(spanID)) {
    return undefined
  }
  if (!Number.isInteger(traceFlags) || traceFlags < 0 || traceFlags > MAX_TRACE_FLAGS) {
    return undefined
  }
  return `00-${traceID}-${spanID}-${traceFlags.toString(16).padStart(2, '0')}`
}

/**
 * Parse a W3C traceparent header value. Returns undefined if invalid.
 *
 * Version handling follows the spec: `ff` is invalid outright; version `00` must carry
 * exactly four fields; a higher version has its first four fields parsed and any
 * trailing content ignored, so a future sender still propagates through us.
 *
 * Unknown flag bits from a future version are preserved on `traceFlags` but never
 * interpreted — only bit 0 (sampled) is ever read.
 */
export function parseTraceparent(header: string): TraceparentData | undefined {
  const match = TRACEPARENT_REGEX.exec(header)
  if (match == null) {
    return undefined
  }
  const [, version, traceID, spanID, flags, trailing] = match
  if (version === 'ff') {
    return undefined
  }
  if (version === '00' && trailing != null) {
    return undefined
  }
  if (!isValidTraceID(traceID) || !isValidSpanID(spanID)) {
    return undefined
  }
  return {
    traceID,
    spanID,
    traceFlags: Number.parseInt(flags, 16),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/traceparent.test.ts`
Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/traceparent.ts test/traceparent.test.ts
git commit -m "fix(otel): reject invalid traceparent IDs, tolerate future versions"
```

---

### Task 3: `tracestate.ts` — dedupe keys on format

**Files:**
- Modify: `src/tracestate.ts:27-41` (`formatTracestate`)
- Test: `test/tracestate.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `formatTracestate(entries: Array<TracestateEntry>): string` — signature unchanged, behaviour tightened. No other task depends on the change.

- [ ] **Step 1: Write the failing tests**

Append to `test/tracestate.test.ts`, inside the existing `describe('formatTracestate', ...)` block:

```ts
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
```

If `parseTracestate` is not already imported in that file, add it to the existing import from `../src/tracestate.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/tracestate.test.ts`
Expected: FAIL — `drops duplicate keys` gets `'vendor=first,other=kept,vendor=second'`.

- [ ] **Step 3: Add dedupe to `formatTracestate`**

Replace the body of `formatTracestate` in `src/tracestate.ts`. The `seen` set mirrors what `parseTracestate` already does, and it is checked *before* the cap so duplicates never consume cap budget:

```ts
/**
 * Format a W3C tracestate header value. Drops members with invalid keys or
 * values, drops duplicate keys (keeping the first occurrence, matching
 * `parseTracestate`), caps at 32 entries, and preserves the given order.
 * Never throws.
 */
export function formatTracestate(entries: Array<TracestateEntry>): string {
  const out: Array<string> = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!isValidKey(entry.key) || !isValidValue(entry.value)) {
      logger.warn('dropping invalid tracestate member {key}', { key: entry.key })
      continue
    }
    if (seen.has(entry.key)) {
      logger.warn('dropping duplicate tracestate member {key}', { key: entry.key })
      continue
    }
    if (out.length >= MAX_ENTRIES) {
      logger.warn('tracestate exceeds 32 entries, dropping {key}', { key: entry.key })
      continue
    }
    seen.add(entry.key)
    out.push(`${entry.key}=${entry.value}`)
  }
  return out.join(',')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/tracestate.test.ts`
Expected: PASS — all cases, including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/tracestate.ts test/tracestate.test.ts
git commit -m "fix(otel): dedupe keys in formatTracestate"
```

---

### Task 4: `context.ts` — delete the `tid`/`sid` path, add `injectW3CTraceContext`

This is the load-bearing task. It removes two public exports.

**Files:**
- Modify: `src/context.ts`
- Modify: `src/index.ts:18-24` (the `./context.js` export block)
- Test: `test/context.test.ts` (rewrite the `injectTraceContext` / `extractTraceContext` blocks)

**Interfaces:**
- Consumes: `formatTraceparent`, `parseTraceparent`, `TraceparentData` from `./traceparent.js` (Task 2); `toRemoteSpanContext` from `./span-context.js` (Task 1).
- Produces:
  - `injectW3CTraceContext<T extends Record<string, unknown>>(meta: T): T` — **new export**
  - `injectTraceContext`, `extractTraceContext` — **removed exports**
  - `extractW3CTraceContext`, `withActiveContext`, `setSpanOnContext` — unchanged signatures

**Testing note — there is no OTel SDK registered in this test suite.** `tracer.startSpan()` therefore returns a *no-op* span whose IDs are all-zero, which is exactly the case `injectW3CTraceContext` must skip. To get a span with real IDs without an SDK, activate a remote span context: `extractW3CTraceContext({ traceparent })` returns a `Context` carrying a non-recording span with the parsed IDs, and `withActiveContext` makes it the active one. The round-trip test below uses that.

- [ ] **Step 1: Write the failing tests**

In `test/context.test.ts`: delete the `describe('injectTraceContext', ...)` and `describe('extractTraceContext', ...)` blocks entirely, drop both names from the import, add `injectW3CTraceContext` to it, and append:

```ts
describe('injectW3CTraceContext', () => {
  test('returns meta unchanged when no span is active', () => {
    const meta = { procedure: 'test' }
    const result = injectW3CTraceContext(meta)
    expect(result).toEqual(meta)
    expect(result).not.toHaveProperty('traceparent')
  })

  test('returns meta unchanged for a no-op span with all-zero IDs', () => {
    // Without an SDK registered, startSpan produces a no-op span. Stamping its
    // all-zero IDs would hand a downstream service an invalid parent.
    const tracer = createTracer('test')
    const span = tracer.startSpan('test')
    const meta = withActiveContext(setSpanOnContext(undefined, span), () =>
      injectW3CTraceContext({ procedure: 'test' }),
    )
    span.end()
    expect(meta).not.toHaveProperty('traceparent')
  })

  test('preserves existing meta properties', () => {
    const result = injectW3CTraceContext({ procedure: 'test', requestID: 'abc' })
    expect(result.procedure).toBe('test')
    expect(result.requestID).toBe('abc')
  })

  test('round-trips through extractW3CTraceContext', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01'
    const parentContext = extractW3CTraceContext({ traceparent })
    const meta = withActiveContext(parentContext, () => injectW3CTraceContext({}))
    expect(meta.traceparent).toBe(traceparent)
  })

  test('stamps tracestate when the active span carries one', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01'
    const parentContext = extractW3CTraceContext({ traceparent, tracestate: 'vendor=value' })
    const meta = withActiveContext(parentContext, () => injectW3CTraceContext({}))
    expect(meta.tracestate).toBe('vendor=value')
  })

  test('omits tracestate when the active span has none', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01'
    const parentContext = extractW3CTraceContext({ traceparent })
    const meta = withActiveContext(parentContext, () => injectW3CTraceContext({}))
    expect(meta).not.toHaveProperty('tracestate')
  })
})
```

Then, inside the existing `describe('extractW3CTraceContext', ...)` block, append the validation cases the deleted path used to let through:

```ts
  test('returns undefined for an all-zero trace ID', () => {
    expect(
      extractW3CTraceContext({
        traceparent: `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`,
      }),
    ).toBeUndefined()
  })

  test('returns undefined for an all-zero span ID', () => {
    expect(
      extractW3CTraceContext({
        traceparent: `00-0af7651916cd43dd8448eb211c80319c-${'0'.repeat(16)}-01`,
      }),
    ).toBeUndefined()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/context.test.ts`
Expected: FAIL — `injectW3CTraceContext` is not exported.

- [ ] **Step 3: Rewrite `src/context.ts`**

```ts
import { type Context, context, createTraceState, ROOT_CONTEXT, type Span, trace } from '@opentelemetry/api'

import { toRemoteSpanContext } from './span-context.js'
import { formatTraceparent, parseTraceparent } from './traceparent.js'
import { formatTracestate, parseTracestate } from './tracestate.js'

/**
 * Stamp the active span's trace context onto a request's `_meta` record as W3C
 * `traceparent` (and `tracestate`, when the span carries one).
 *
 * Returns the record unchanged when there is no active span, or when the active
 * span cannot produce a valid header — which covers OTel's no-op spans, whose
 * all-zero IDs would otherwise be handed downstream as a parent.
 *
 * The inject-side twin of `extractW3CTraceContext`.
 */
export function injectW3CTraceContext<T extends Record<string, unknown>>(meta: T): T {
  const span = trace.getSpan(context.active())
  if (span == null) {
    return meta
  }
  const spanContext = span.spanContext()
  const traceparent = formatTraceparent(
    spanContext.traceId,
    spanContext.spanId,
    spanContext.traceFlags,
  )
  if (traceparent == null) {
    return meta
  }
  const tracestate = spanContext.traceState?.serialize()
  return tracestate ? { ...meta, traceparent, tracestate } : { ...meta, traceparent }
}

/**
 * Build an OTel Context from a request's W3C trace headers in `_meta`. Parses
 * `meta.traceparent` (and optional `meta.tracestate`) into a remote SpanContext.
 * Returns undefined when no valid `traceparent` is present, so callers pay
 * nothing when tracing is off. Pairs with `withActiveContext` for activation.
 */
export function extractW3CTraceContext(meta: Record<string, unknown>): Context | undefined {
  const traceparent = meta.traceparent
  if (typeof traceparent !== 'string') {
    return undefined
  }
  const parsed = parseTraceparent(traceparent)
  if (parsed == null) {
    return undefined
  }
  let traceState = undefined
  if (typeof meta.tracestate === 'string') {
    const formatted = formatTracestate(parseTracestate(meta.tracestate))
    if (formatted !== '') {
      traceState = createTraceState(formatted)
    }
  }
  const spanContext = toRemoteSpanContext(parsed, traceState)
  if (spanContext == null) {
    return undefined
  }
  return trace.setSpanContext(ROOT_CONTEXT, spanContext)
}

export function withActiveContext<T>(parentContext: Context | undefined, fn: () => T): T {
  const ctx = parentContext ?? context.active()
  return context.with(ctx, fn)
}

export function setSpanOnContext(parentContext: Context | undefined, span: Span): Context {
  const ctx = parentContext ?? context.active()
  return trace.setSpan(ctx, span)
}
```

Note what left the imports: `SpanContext`, `TraceFlags`, and `ZERO_TRACE_ID` are all gone — the force-sampling and the ad-hoc zero check went with the deleted path.

- [ ] **Step 4: Update the export block in `src/index.ts`**

Replace lines 18-24:

```ts
export {
  extractW3CTraceContext,
  injectW3CTraceContext,
  setSpanOnContext,
  withActiveContext,
} from './context.js'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/context.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, to catch any stale reference to the deleted exports**

Run: `pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/context.ts src/index.ts test/context.test.ts
git commit -m "feat(otel)!: replace tid/sid propagation with injectW3CTraceContext"
```

---

### Task 5: `tracers.ts` — caller-supplied version, no `setStatus(OK)`

**Files:**
- Modify: `src/tracers.ts`
- Test: `test/tracers.test.ts` (extend)

**Interfaces:**
- Consumes: `isValidTraceID` from `./span-context.js` (Task 1).
- Produces:
  - `createTracerFactory(prefix: string, version?: string): (name: string) => Tracer` — new optional second parameter. Existing single-argument call sites keep working.
  - `getActiveSpan`, `getActiveTraceContext`, `getActiveBaggage`, `withSpan`, `withSyncSpan`, `withActiveBaggage`, `TraceContext` — unchanged signatures.

**Why the version moves to the caller:** tracer names are `` `${prefix}.${name}` `` where `prefix` identifies the *consuming* package. OTel defines the instrumentation-scope version as the version of the instrumentation library — the consumer's, not `@sozai/otel`'s. The hardcoded `OTEL_PACKAGE_VERSION = '0.1.0'` was not merely stale; it stamped the wrong package's version onto someone else's tracer.

- [ ] **Step 1: Write the failing tests**

Add `SpanStatusCode` to the test file's imports (`import { SpanStatusCode } from '@opentelemetry/api'`), then append:

```ts
describe('createTracerFactory version', () => {
  test('accepts a caller-supplied version', () => {
    const tracer = createTracerFactory('enkaku', '1.2.3')('client')
    expect(tracer).toBeDefined()
    expect(typeof tracer.startSpan).toBe('function')
  })

  test('works without a version', () => {
    const tracer = createTracerFactory('enkaku')('client')
    expect(tracer).toBeDefined()
    expect(typeof tracer.startSpan).toBe('function')
  })
})

describe('span status', () => {
  test('leaves status UNSET on success rather than setting OK', () => {
    // OTel reserves Ok for an explicit application override; instrumentation
    // leaves the status Unset, which backends read as success.
    const tracer = createTracer('test')
    const statuses: Array<unknown> = []
    withSyncSpan(tracer, 'test', {}, (span) => {
      const original = span.setStatus.bind(span)
      span.setStatus = (status) => {
        statuses.push(status)
        return original(status)
      }
      return 'ok'
    })
    expect(statuses).toEqual([])
  })

  test('still sets ERROR status when the callback throws', () => {
    const tracer = createTracer('test')
    const statuses: Array<{ code: number }> = []
    expect(() =>
      withSyncSpan(tracer, 'test', {}, (span) => {
        const original = span.setStatus.bind(span)
        span.setStatus = (status) => {
          statuses.push(status as { code: number })
          return original(status)
        }
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(statuses).toHaveLength(1)
    expect(statuses[0].code).toBe(SpanStatusCode.ERROR)
  })
})
```

Both tests capture the span through `withSyncSpan`'s callback — the span it creates internally is not otherwise reachable from the test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/tracers.test.ts`
Expected: FAIL — `leaves status UNSET on success` gets one `{ code: 1 }` entry, because `withSyncSpan` currently calls `setStatus(OK)`.

- [ ] **Step 3: Edit `src/tracers.ts`**

Three edits.

First, delete the `OTEL_PACKAGE_VERSION` constant and thread the version through the factory:

```ts
/**
 * Build a tracer factory for a consuming package.
 *
 * `version` is the *consumer's* package version, not this package's: OTel defines the
 * instrumentation-scope version as the version of the instrumentation library, and the
 * tracer name (`prefix.name`) identifies the consumer. `undefined` is a legal scope
 * version, so the parameter is optional.
 */
export function createTracerFactory(prefix: string, version?: string): (name: string) => Tracer {
  return (name: string): Tracer => trace.getTracer(`${prefix}.${name}`, version)
}
```

Second, in `withSyncSpan`, delete the success-path `setStatus` call:

```ts
  try {
    return context.with(spanCtx, () => fn(span))
  } catch (error) {
```

Third, in `withSpan`, delete its success-path `setStatus` call:

```ts
    try {
      return await fn(span)
    } catch (error) {
```

Leave both `catch` blocks — `setStatus(ERROR)` plus `recordException` plus rethrow — exactly as they are, and both `finally { span.end() }` blocks too.

Fourth, swap the no-op-span guard in `getActiveTraceContext` to the shared validator, and drop the now-unused `ZERO_TRACE_ID` import:

```ts
import { isValidTraceID } from './span-context.js'
```

```ts
export function getActiveTraceContext(): TraceContext | undefined {
  const span = trace.getSpan(context.active())
  if (span == null) {
    return undefined
  }
  const ctx = span.spanContext()
  // No-op spans carry all-zero IDs; they are not a real trace context.
  if (!isValidTraceID(ctx.traceId)) {
    return undefined
  }
  return {
    traceID: ctx.traceId,
    spanID: ctx.spanId,
    traceFlags: ctx.traceFlags,
  }
}
```

`SpanStatusCode` stays imported — the error paths still use it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/tracers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tracers.ts test/tracers.test.ts
git commit -m "fix(otel): caller-supplied tracer version, leave span status UNSET on success"
```

---

### Task 6: `log-sink.ts` — import logtape's real `LogRecord`

**Files:**
- Modify: `packages/log/src/index.ts` (re-export the type)
- Modify: `packages/otel/src/log-sink.ts`
- Test: `packages/otel/test/log-sink.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `createOTelLogSink(): (record: LogRecord) => void` — the `LogRecord` is now logtape's, imported from `@sozai/log`. `@sozai/log` gains a `LogRecord` type export.

**Two bugs the local copy hides:**
1. Its `level` is `string`, and the severity map carries both `warning` and `warn`. Logtape's real `LogLevel` is `'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal'` — there is no `'warn'`. That key is dead code.
2. Its `rawMessage` is `string`, but logtape's is `string | TemplateStringsArray`. The sink assigns `rawMessage` straight to the OTel log `body`, so a tagged-template call site (`` logger.info`hello ${name}` ``) currently emits a raw array as the body. This ships today.

- [ ] **Step 1: Write the failing test**

Replace `packages/otel/test/log-sink.test.ts` with:

```ts
import { describe, expect, test } from 'vitest'

import { createOTelLogSink } from '../src/log-sink.js'

describe('createOTelLogSink', () => {
  test('returns a function (Sink type)', () => {
    const sink = createOTelLogSink()
    expect(typeof sink).toBe('function')
  })

  test('accepts a log record without throwing', () => {
    const sink = createOTelLogSink()
    expect(() =>
      sink({
        category: ['sozai', 'server'],
        level: 'info',
        message: ['server started'],
        rawMessage: 'server started',
        properties: { serverID: 'test-id' },
        timestamp: Date.now(),
      }),
    ).not.toThrow()
  })

  test('accepts a tagged-template record, whose rawMessage is a TemplateStringsArray', () => {
    // logtape's rawMessage is `string | TemplateStringsArray`. The sink must not
    // hand the array straight to the OTel log body.
    const sink = createOTelLogSink()
    const rawMessage = Object.assign(['server ', ' started'], {
      raw: ['server ', ' started'],
    }) as unknown as TemplateStringsArray
    expect(() =>
      sink({
        category: ['sozai', 'server'],
        level: 'info',
        message: ['server ', 'test-id', ' started'],
        rawMessage,
        properties: {},
        timestamp: Date.now(),
      }),
    ).not.toThrow()
  })

  test('accepts every logtape level', () => {
    const sink = createOTelLogSink()
    const levels = ['trace', 'debug', 'info', 'warning', 'error', 'fatal'] as const
    for (const level of levels) {
      expect(() =>
        sink({
          category: ['sozai'],
          level,
          message: ['msg'],
          rawMessage: 'msg',
          properties: {},
          timestamp: Date.now(),
        }),
      ).not.toThrow()
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it typechecks-fails**

Run: `pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: FAIL — the tagged-template case does not satisfy the local `LogRecord`'s `rawMessage: string`.

- [ ] **Step 3: Re-export `LogRecord` from `@sozai/log`**

In `packages/log/src/index.ts`, add `LogRecord` to the existing type import and the existing type re-export:

```ts
import type { Config, ConsoleSinkOptions, Logger, LogLevel, LogRecord } from '@logtape/logtape'
```

```ts
export type { Config, ConsoleSinkOptions, Logger, LogLevel, LogRecord }
```

- [ ] **Step 4: Rewrite `packages/otel/src/log-sink.ts`**

```ts
import { context, trace } from '@opentelemetry/api'
import { type LogAttributes, logs, SeverityNumber } from '@opentelemetry/api-logs'
import type { LogLevel, LogRecord } from '@sozai/log'

const LEVEL_TO_SEVERITY: Record<LogLevel, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warning: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
}

export function createOTelLogSink(): (record: LogRecord) => void {
  const logger = logs.getLogger('sozai')

  return (record: LogRecord) => {
    const activeSpan = trace.getSpan(context.active())

    const attributes: LogAttributes = {
      ...(record.properties as LogAttributes),
      'log.category': record.category.join('.'),
    }

    // logtape's rawMessage is a TemplateStringsArray for tagged-template call sites
    // (logger.info`hello ${name}`) and a string otherwise. The OTel body takes a string.
    const body =
      typeof record.rawMessage === 'string' ? record.rawMessage : record.rawMessage.join('')

    logger.emit({
      severityNumber: LEVEL_TO_SEVERITY[record.level],
      severityText: record.level,
      body,
      attributes,
      timestamp: record.timestamp,
      context: activeSpan ? context.active() : undefined,
    })
  }
}
```

The `Record<LogLevel, SeverityNumber>` is exhaustive, so the old `?? 9` fallback is gone: an unmapped level is now a compile error rather than a silent `INFO`.

- [ ] **Step 5: Add the `@logtape/logtape` types to `@sozai/otel`'s reach**

`@sozai/otel` already depends on `@sozai/log` (`workspace:^`), and the `LogRecord` type now comes through it. No new dependency is needed. Confirm with:

Run: `pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no errors. If it complains that `LogRecord` is not exported from `@sozai/log`, rebuild the log package's types first: `pnpm --filter @sozai/log exec tsc --emitDeclarationOnly --skipLibCheck`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/log-sink.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 7: Commit**

```bash
git add ../log/src/index.ts src/log-sink.ts test/log-sink.test.ts
git commit -m "fix(otel): import logtape's LogRecord, fix tagged-template log body"
```

---

### Task 7: Docs and changeset

**Files:**
- Modify: `docs/reference/observability.md` (repo root, not the package)
- Create: `.changeset/<changeset-name>.md`
- Delete: `docs/agents/plans/next/otel-w3c-compliance.md`

**Interfaces:**
- Consumes: the final API surface from Tasks 4, 5, 6.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Update the context-propagation table**

In `docs/reference/observability.md`, in the `#### Context propagation` table (around line 73): delete the `extractTraceContext` and `injectTraceContext` rows, and add:

```markdown
| `injectW3CTraceContext` | function | Stamp `traceparent` (and `tracestate`, when present) onto a meta record from the active span. Returns the record unchanged when there is no active span, or when the active span cannot produce a valid header. |
```

Keep the rows for `extractW3CTraceContext` and `getActiveTraceContext`.

- [ ] **Step 2: Update the "When to use" line**

Around line 206, replace the `@sozai/otel` bullet's second half. It currently offers the custom header contract as an alternative:

> use `extractW3CTraceContext` + `formatTraceparent` for W3C `traceparent` propagation, or `extractTraceContext` + `injectTraceContext` for the custom `tid`/`sid` header contract.

with:

> use `injectW3CTraceContext` + `extractW3CTraceContext` for W3C `traceparent`/`tracestate` propagation across a request boundary.

- [ ] **Step 3: Write the changeset**

Create `.changeset/otel-w3c-compliance.md`:

```markdown
---
'@sozai/otel': minor
'@sozai/log': minor
---

W3C Trace Context compliance.

**Breaking (`@sozai/otel`):**

- `injectTraceContext` and `extractTraceContext` are **removed**. The custom `tid`/`sid`
  header contract was a second, unvalidated encoding of the same three values the W3C
  path already carries: it skipped ID validation entirely and hardcoded
  `TraceFlags.SAMPLED`, so any string became a remote `SpanContext` and every remote
  trace was force-sampled. Use `injectW3CTraceContext` + `extractW3CTraceContext`.
- `formatTraceparent` now returns `string | undefined`, returning `undefined` rather
  than emitting a structurally invalid header.
- `createTracerFactory(prefix, version?)` takes the consuming package's version. It
  previously hardcoded a stale `@sozai/otel` version, which was also the wrong package's
  version to report as the instrumentation scope.

**Fixes (`@sozai/otel`):**

- All-zero trace IDs and span IDs are rejected on both parse and format. They previously
  became remote `SpanContext`s that SDKs parented real spans to.
- `parseTraceparent` rejects version `ff` and parses the first four fields of a higher
  version, per the spec's forward-compatibility rule.
- `formatTracestate` drops duplicate keys, matching `parseTracestate`.
- Successful spans are left `Unset` rather than set to `Ok`, per OTel guidance.
- The OTel log sink no longer emits a raw array as the log body for tagged-template log
  calls (`` logger.info`hello ${name}` ``), a bug hidden by a hand-copied `LogRecord`
  type that had drifted from logtape's.

**`@sozai/log`:** re-exports logtape's `LogRecord` type.
```

- [ ] **Step 4: Delete the now-superseded backlog item**

```bash
git rm docs/agents/plans/next/otel-w3c-compliance.md
```

- [ ] **Step 5: Run the full package suite and lint**

From the repo root:

Run: `pnpm --filter @sozai/otel exec vitest run`
Expected: PASS — all files.

Run: `pnpm --filter @sozai/log exec vitest run`
Expected: PASS.

Run: `pnpm exec biome check packages/otel packages/log`
Expected: no diagnostics. If biome reports formatting, run `pnpm exec biome check --write packages/otel packages/log` and re-check.

Run: `pnpm exec tsc --noEmit --skipLibCheck -p packages/otel/tsconfig.test.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add docs/reference/observability.md .changeset/otel-w3c-compliance.md docs/agents/plans/next/otel-w3c-compliance.md
git commit -m "docs(otel): W3C propagation surface, changeset"
```
