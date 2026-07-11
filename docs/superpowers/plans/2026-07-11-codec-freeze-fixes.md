# codec Freeze-Blocker Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks
**Spec:** [2026-07-11-codec-freeze-fixes-design](../specs/2026-07-11-codec-freeze-fixes-design.md)

**Goal:** Fix the four API-breaking correctness defects in `@sozai/codec` before the package freezes — unpadded base64url, a fatal UTF-8 decoder, a `canonicalStringify` that throws instead of lying, and a validation guard on `fromB64`.

**Architecture:** All changes are behavioural, inside functions that already exist in a single 147-line file. No new exports, no removed exports, no new files in `src/`. Each task changes one or two functions plus their tests, and each ends green.

**Tech Stack:** TypeScript (ESM, `nodenext`), vitest, biome, changesets, pnpm. Dependency: `canonicalize` 3.0.0 (catalog-pinned).

## Global Constraints

- **Working directory for all commands:** `packages/codec`. Every `Run:` line in this plan assumes you are there.
- **Do not use `pnpm run <script>`.** An `rtk` shim on this machine intercepts it and invokes the wrong tool. Use `npx <tool>` / `pnpm exec <tool>` directly, exactly as written in each step.
- **Never edit `packages/codec/lib/`** — it is generated build output.
- Conventions (from `AGENTS.md`): `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`.
- Formatting is biome. If a step's code fails `npx biome check`, run `npx biome check --write src test` and keep going.
- **`toB64` stays padded.** RFC 4648 §4 mandates padding for standard base64. Only `toB64U` becomes unpadded. Do not "fix" `toB64`'s padding tests — they are correct.
- **`fromB64U` keeps accepting padded input.** Lenient decode, strict encode. Its existing `B64U_RE` already allows `={0,2}` and must not be tightened — already-issued `@kokuin/token` tokens depend on this.

**Verified environment facts** (checked against Node v26.4.0 and this repo's tsconfig before the plan was written — trust these, no need to re-derive):

- `omitPadding`, `Uint8Array.prototype.toBase64`, and `Uint8Array.fromBase64` all typecheck cleanly under the codec's `lib: ["es2025", "dom", "esnext"]`. **No casts are needed anywhere in this plan.**
- Native `Uint8Array.fromBase64` accepts padded *and* unpadded input (default `lastChunkHandling` is `'loose'`).
- `canonicalize`'s shipped type is `(input: unknown) => string | undefined`, so removing the `@ts-expect-error` and narrowing the `undefined` away is all that is required.
- Baseline: 36 tests pass in `packages/codec` before any change.

---

### Task 1: `toB64U` emits unpadded base64url

The decision gate from the spec. Ed25519 signatures are 64 bytes and `64 % 3 === 1`, so every `@kokuin/token` JWS signature currently ends in `==` — illegal in JWS compact serialisation (RFC 7515 §2).

**Files:**
- Modify: `packages/codec/src/index.ts:64-72` (`toB64U`)
- Test: `packages/codec/test/lib.test.ts:53-72` (the existing `describe('toB64U() padding')` block — replaced wholesale)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `toB64U(bytes: Uint8Array): string` — unchanged signature, now returns output matching `/^[A-Za-z0-9_-]*$/` with no `=`. Tasks 5 and 6 rely on this.

- [ ] **Step 1: Write the failing tests**

Replace the whole `describe('toB64U() padding', ...)` block at `test/lib.test.ts:53-72` with:

```ts
describe('toB64U() output', () => {
  test('emits no padding when byte length is a multiple of 3', () => {
    expect(toB64U(new Uint8Array([1, 2, 3]))).toBe('AQID')
  })

  test('emits no padding when byte length mod 3 === 2', () => {
    expect(toB64U(new Uint8Array([104, 105]))).toBe('aGk')
  })

  test('emits no padding when byte length mod 3 === 1', () => {
    expect(toB64U(new Uint8Array([97]))).toBe('YQ')
  })

  test('uses the URL-safe alphabet', () => {
    expect(toB64U(new Uint8Array([0xfb, 0xff]))).toBe('-_8')
  })

  test('output matches the strict unpadded base64url regex', () => {
    const re = /^[A-Za-z0-9_-]*$/
    expect(re.test(toB64U(new Uint8Array([1, 2, 3])))).toBe(true)
    expect(re.test(toB64U(new Uint8Array([104, 105])))).toBe(true)
    expect(re.test(toB64U(new Uint8Array([97])))).toBe(true)
    expect(re.test(toB64U(new Uint8Array([0xfb, 0xff])))).toBe(true)
  })

  test('round-trips through fromB64U at every residue length', () => {
    for (const bytes of [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([104, 105]),
      new Uint8Array([97]),
    ]) {
      expect(equals(fromB64U(toB64U(bytes)), bytes)).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t 'toB64U() output'`
Expected: FAIL — `expected 'aGk=' to be 'aGk'` (and the `YQ==` / regex cases too). The multiple-of-3 and round-trip cases already pass; that is fine.

- [ ] **Step 3: Write the implementation**

Replace `toB64U` at `src/index.ts:64-72` with:

```ts
/**
 * Convert a Uint8Array to an unpadded base64url-encoded string.
 *
 * Output carries no `=` padding, as required by RFC 7515 (JWS) and RFC 4648 §5. Note that
 * `toB64` (standard base64) *is* padded, per RFC 4648 §4.
 */
export function toB64U(bytes: Uint8Array): string {
  if (typeof Uint8Array.prototype.toBase64 === 'function') {
    return bytes.toBase64({ alphabet: 'base64url', omitPadding: true })
  }
  return toB64(bytes)
    .replace(/=+$/, '')
    .replace(/[+/]/g, (m) => (m === '+' ? '-' : '_'))
}
```

Two things changed beyond the padding: the return type is now explicit (`: string` — it was inferred), and the feature check moved from `'toBase64' in bytes` to `typeof Uint8Array.prototype.toBase64 === 'function'`, matching the `typeof` style `fromB64U` already uses. Task 4 applies the same unification to `toB64`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: PASS — all tests, 38 total. `toB64`'s padding tests must still pass unchanged; if they fail you edited the wrong function.

- [ ] **Step 5: Commit**

```bash
git add packages/codec/src/index.ts packages/codec/test/lib.test.ts
git commit -m "fix(codec)!: emit unpadded base64url from toB64U

RFC 7515 compact serialisation forbids '=' padding. Every Ed25519 JWS
signature (64 bytes, 64 % 3 == 1) previously ended in '=='.

toB64 stays padded per RFC 4648 §4; fromB64U still accepts padded input,
so already-issued tokens keep verifying."
```

---

### Task 2: `toUTF` uses a fatal decoder

`toUTF` currently decodes corrupted bytes into U+FFFD-mangled text instead of failing. This package sits under signature verification, so a tampered payload must fail loudly rather than parse into *a* string.

**Files:**
- Modify: `packages/codec/src/index.ts:74-86` (`fromUTF`, `toUTF`)
- Test: `packages/codec/test/lib.test.ts` (append a new `describe` block at the end)

**Interfaces:**
- Consumes: `toB64U` from Task 1 — the string `'_w'` used below is `toB64U(new Uint8Array([0xff]))`.
- Produces: `toUTF(bytes: Uint8Array): string` — unchanged signature, now throws a native `TypeError` ("The encoded data was not valid for encoding utf-8") on invalid UTF-8. The throw propagates through `b64uToUTF` and `b64uToJSON`.

- [ ] **Step 1: Write the failing tests**

Append to `test/lib.test.ts`:

```ts
describe('toUTF() strictness', () => {
  test('throws on a lone invalid byte', () => {
    expect(() => toUTF(new Uint8Array([0xff]))).toThrow(TypeError)
  })

  test('throws on a truncated multibyte sequence rather than substituting U+FFFD', () => {
    expect(() => toUTF(new Uint8Array([0xc3, 0x28]))).toThrow(TypeError)
  })

  test('invalid UTF-8 propagates through b64uToUTF', () => {
    // '_w' is toB64U(new Uint8Array([0xff]))
    expect(() => b64uToUTF('_w')).toThrow(TypeError)
  })

  test('invalid UTF-8 propagates through b64uToJSON', () => {
    expect(() => b64uToJSON('_w')).toThrow(TypeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t 'toUTF() strictness'`
Expected: FAIL — the decoder returns a U+FFFD string instead of throwing, so the first three fail with "expected function to throw an error, but it didn't". (The `b64uToJSON` case may already pass for the wrong reason — `JSON.parse` chokes on the mangled text. It must still be present; after Step 3 it fails for the *right* reason.)

- [ ] **Step 3: Write the implementation**

Replace `fromUTF` and `toUTF` at `src/index.ts:74-86` with:

```ts
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * Convert a UTF string to a Uint8Array.
 */
export function fromUTF(value: string): Uint8Array {
  return encoder.encode(value)
}

/**
 * Convert a Uint8Array to a UTF string.
 *
 * Throws a `TypeError` if the bytes are not valid UTF-8. Decoding is deliberately strict:
 * this codec sits under signature verification, where silently substituting U+FFFD would let
 * corrupted bytes decode to a plausible string.
 */
export function toUTF(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}
```

Both the encoder and decoder are hoisted to module-level constants — they hold no per-call state when not streaming, so constructing one per call was pure waste.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: PASS — 42 tests. The existing `fromUTF() / toUTF()` round-trip tests (ASCII, Unicode, multibyte, empty string) must still pass; the fatal decoder only rejects *invalid* UTF-8.

- [ ] **Step 5: Commit**

```bash
git add packages/codec/src/index.ts packages/codec/test/lib.test.ts
git commit -m "fix(codec)!: fail on invalid UTF-8 instead of substituting U+FFFD

toUTF now uses a fatal TextDecoder, so corrupted bytes throw rather than
decoding to a mangled string. Propagates through b64uToUTF/b64uToJSON.

Also hoists the encoder/decoder to module constants."
```

---

### Task 3: `canonicalStringify` throws instead of lying

`canonicalize` returns `undefined` for `undefined`, functions, and symbols. The `@ts-expect-error` hides that, the declared `: string` is false, and `fromUTF(undefined)` yields empty bytes — so `b64uFromJSON` silently produces `""` instead of throwing.

**Files:**
- Modify: `packages/codec/src/index.ts:15-19` (`canonicalStringify`)
- Test: `packages/codec/test/lib.test.ts` (append a new `describe` block at the end)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `canonicalStringify(value: unknown): string` — unchanged signature, now genuinely returns a string or throws a `TypeError`. No longer tagged `@internal`.

- [ ] **Step 1: Write the failing tests**

Append to `test/lib.test.ts`:

```ts
describe('canonicalStringify() non-serializable values', () => {
  test('throws on undefined', () => {
    expect(() => canonicalStringify(undefined)).toThrow(TypeError)
  })

  test('throws on a function', () => {
    expect(() => canonicalStringify(() => {})).toThrow(TypeError)
  })

  test('throws on a symbol', () => {
    expect(() => canonicalStringify(Symbol('nope'))).toThrow(TypeError)
  })

  test('b64uFromJSON throws rather than encoding an empty string', () => {
    expect(() => b64uFromJSON(undefined as unknown as Record<string, unknown>)).toThrow(TypeError)
  })

  test('still drops object keys whose value is undefined', () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}')
  })
})
```

The last test pins the behaviour we are *not* changing: a top-level non-serializable value throws, but an object with an `undefined`-valued key still serializes with that key dropped, exactly like `JSON.stringify`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t 'canonicalStringify() non-serializable'`
Expected: FAIL — the first four fail with "expected function to throw an error, but it didn't" (`canonicalStringify(undefined)` currently returns `undefined`, and `b64uFromJSON(undefined)` returns `''`). The final `{ a: undefined, b: 1 }` test already passes.

- [ ] **Step 3: Write the implementation**

Replace `canonicalStringify` at `src/index.ts:15-19` with:

```ts
/**
 * Serialize a value to canonical JSON, with deterministic key ordering.
 *
 * Throws a `TypeError` if the value has no JSON representation at all — `undefined`, a
 * function or a symbol. Returning a non-string here would silently encode to `""` downstream
 * in {@link b64uFromJSON}.
 *
 * Known upstream limitation: a *nested* function or symbol serializes to the literal token
 * `undefined`, producing invalid JSON, rather than having its key dropped. Tracked by
 * https://github.com/erdtman/canonicalize/pull/22
 */
export function canonicalStringify(value: unknown): string {
  const serialized = serialize(value)
  if (serialized === undefined) {
    throw new TypeError('Value has no canonical JSON representation')
  }
  return serialized
}
```

The `@ts-expect-error` is gone: `canonicalize` is typed `(input: unknown) => string | undefined`, and the `undefined` check narrows it. **If you leave the `@ts-expect-error` in place, the build fails** — TypeScript reports an unused `@ts-expect-error` directive once the error it suppressed no longer occurs.

The `@internal` tag is also gone. `@kokuin/token`'s `token.ts` already imports `canonicalStringify`, so it is public in practice and about to be frozen that way.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.test.json`
Expected: PASS — 47 tests, and the typecheck exits 0 with no output.

- [ ] **Step 5: Commit**

```bash
git add packages/codec/src/index.ts packages/codec/test/lib.test.ts
git commit -m "fix(codec)!: throw from canonicalStringify on non-serializable values

canonicalize returns undefined for undefined/function/symbol, which a
@ts-expect-error hid behind a declared ': string'. b64uFromJSON then encoded
'' instead of throwing.

Also un-marks @internal: @kokuin/token already imports this."
```

---

### Task 4: `fromB64` validation guard

Without a guard, `fromB64` silently accepts malformed input — embedded whitespace, base64url characters — on both the native and `atob` paths, decoding it as if nothing were wrong. This is a strictness fix, not an alignment fix: it makes `fromB64` fail loudly on malformed input, matching the strictness `fromB64U` already has via `B64U_RE`. `fromB64` is what `kubun` and `kokuin` use to load private keys from environment variables, CLI flags, and files — those sources routinely carry a trailing newline, so surrounding whitespace is trimmed before validation rather than rejected. Embedded whitespace still throws; that is the corruption signal worth keeping. `fromB64U` stays fully strict, since its input is JWT segments off the wire, where whitespace is always corruption.

**Files:**
- Modify: `packages/codec/src/index.ts:30-34` (`fromB64`), `src/index.ts:54-62` (`toB64` — feature-detection style only)
- Test: `packages/codec/test/lib.test.ts` (append a new `describe` block at the end)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `fromB64(base64: string): Uint8Array` — unchanged signature, now trims surrounding whitespace and throws `Error('Invalid base64 encoding')` on malformed input (including embedded whitespace). `toB64` is behaviourally unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `test/lib.test.ts`:

```ts
describe('fromB64()', () => {
  test('rejects input containing embedded whitespace', () => {
    // Both the native and atob paths silently strip this space and decode anyway.
    // Embedded whitespace is a corruption signal, unlike surrounding whitespace, which is
    // trimmed before validation.
    expect(() => fromB64('aGVs bG8=')).toThrow('Invalid base64')
  })

  test('tolerates surrounding whitespace', () => {
    // Real-world shapes: a trailing newline from a file/env var, and leading+trailing spaces.
    const bytes = new Uint8Array([104, 101, 108, 108, 111])
    expect(equals(fromB64('aGVsbG8=\n'), bytes)).toBe(true)
    expect(equals(fromB64('  aGVsbG8=  '), bytes)).toBe(true)
  })

  test('rejects input containing an embedded newline', () => {
    // Line-wrapped/PEM-style base64. Rejecting it is intentional.
    expect(() => fromB64('aGVs\nbG8=')).toThrow('Invalid base64')
  })

  test('rejects input containing base64url characters', () => {
    expect(() => fromB64('aGVs-bG8')).toThrow('Invalid base64')
    expect(() => fromB64('aGVs_bG8')).toThrow('Invalid base64')
  })

  test('rejects input containing invalid characters', () => {
    expect(() => fromB64('aGVs!bG8')).toThrow('Invalid base64')
    expect(() => fromB64('aGVs@bG8#')).toThrow('Invalid base64')
  })

  test('rejects input with padding in an invalid position', () => {
    expect(() => fromB64('aGVs=bG8')).toThrow('Invalid base64')
    expect(() => fromB64('aGVsbG8===')).toThrow('Invalid base64')
  })

  test('accepts padded standard base64', () => {
    expect(equals(fromB64('AQID'), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(equals(fromB64('aGk='), new Uint8Array([104, 105]))).toBe(true)
    expect(equals(fromB64('YQ=='), new Uint8Array([97]))).toBe(true)
  })

  test('accepts the standard alphabet', () => {
    expect(equals(fromB64('+/8='), new Uint8Array([0xfb, 0xff]))).toBe(true)
  })

  test('accepts an empty string', () => {
    expect(() => fromB64('')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t 'fromB64()'`
Expected: FAIL — the rejection and tolerance tests fail (Node has the native method, which throws a *different* message on the whitespace cases, so `.toThrow('Invalid base64')` does not match, and the surrounding-whitespace cases either throw or don't decode as expected). The other acceptance tests already pass.

Note: `-t 'fromB64()'` also matches the existing `fromB64U()` block. That is fine — those must stay green.

- [ ] **Step 3: Write the implementation**

Add the regex beside the existing `B64U_RE` and rewrite `fromB64`. Replace `src/index.ts:30-34` with:

```ts
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Convert a base64-encoded string to a Uint8Array.
 *
 * Surrounding whitespace is tolerated — base64 commonly arrives from files, environment
 * variables, and CLI flags with a trailing newline. Embedded whitespace and any character
 * outside the standard alphabet throw `Error('Invalid base64 encoding')`.
 */
export function fromB64(base64: string): Uint8Array {
  const trimmed = base64.trim()
  if (!B64_RE.test(trimmed)) {
    throw new Error('Invalid base64 encoding')
  }
  return typeof Uint8Array.fromBase64 === 'function'
    ? Uint8Array.fromBase64(trimmed, { alphabet: 'base64' })
    : fromB64atob(trimmed)
}
```

Then unify `toB64`'s feature detection — replace `src/index.ts:54-62` with:

```ts
/**
 * Convert a Uint8Array to a padded base64-encoded string.
 */
export function toB64(bytes: Uint8Array): string {
  if (typeof Uint8Array.prototype.toBase64 === 'function') {
    return bytes.toBase64({ alphabet: 'base64' })
  }
  return btoa(Array.from(bytes, (byte: number) => String.fromCodePoint(byte)).join(''))
}
```

All four codec functions now feature-detect with `typeof ... === 'function'`; the odd `'toBase64' in bytes` instance check is gone.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: PASS — 56 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/codec/src/index.ts packages/codec/test/lib.test.ts
git commit -m "fix(codec)!: validate fromB64 input, unify feature detection

fromB64 had no guard, so it silently accepted malformed input — embedded
whitespace, base64url characters — on both the native and atob paths and
decoded it anyway. B64_RE mirrors B64U_RE and makes it fail loudly.

Also switches toB64's \"'toBase64' in bytes\" check to the typeof style the
other three functions use."
```

---

### Task 5: Cover the `atob` fallback path

Node has the native base64 methods, so the fallback branches never run in CI — which is exactly where a padding bug would hide. These tests reach the fallback two ways: the exported `*atob` helpers directly, and by temporarily removing the native method to prove both paths agree.

**Files:**
- Modify: `packages/codec/test/lib.test.ts:4-16` (add `fromB64atob`, `fromB64Uatob` to the import block)
- Test: `packages/codec/test/lib.test.ts` (append a new `describe` block at the end)

**Interfaces:**
- Consumes: `toB64U` (Task 1, unpadded), `fromB64` (Task 4, guarded). No source changes in this task — tests only.
- Produces: nothing.

- [ ] **Step 1: Extend the test imports**

The import block at the top of `test/lib.test.ts` currently reads:

```ts
import {
  b64uFromJSON,
  b64uFromUTF,
  b64uToJSON,
  b64uToUTF,
  canonicalStringify,
  fromB64,
  fromB64U,
  fromUTF,
  toB64,
  toB64U,
  toUTF,
} from '../src/index.js'
```

Add the two fallback helpers, keeping the list alphabetical:

```ts
import {
  b64uFromJSON,
  b64uFromUTF,
  b64uToJSON,
  b64uToUTF,
  canonicalStringify,
  fromB64,
  fromB64atob,
  fromB64U,
  fromB64Uatob,
  fromUTF,
  toB64,
  toB64U,
  toUTF,
} from '../src/index.js'
```

- [ ] **Step 2: Write the failing tests**

Append to `test/lib.test.ts`:

```ts
describe('atob fallback path', () => {
  test('fromB64atob decodes padded standard base64', () => {
    expect(equals(fromB64atob('AQID'), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(equals(fromB64atob('YQ=='), new Uint8Array([97]))).toBe(true)
  })

  test('fromB64Uatob decodes unpadded base64url', () => {
    expect(equals(fromB64Uatob('YQ'), new Uint8Array([97]))).toBe(true)
    expect(equals(fromB64Uatob('aGk'), new Uint8Array([104, 105]))).toBe(true)
  })

  test('fromB64Uatob still decodes padded base64url', () => {
    expect(equals(fromB64Uatob('YQ=='), new Uint8Array([97]))).toBe(true)
  })

  test('fromB64Uatob maps the URL-safe alphabet', () => {
    expect(equals(fromB64Uatob('-_8'), new Uint8Array([0xfb, 0xff]))).toBe(true)
  })

  test('the encode fallback produces the same unpadded output as the native path', () => {
    const cases = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([104, 105]),
      new Uint8Array([97]),
      new Uint8Array([0xfb, 0xff]),
    ]
    const native = cases.map((bytes) => toB64U(bytes))

    const descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64')
    if (descriptor == null) {
      throw new Error('expected a native toBase64 to remove')
    }
    Reflect.deleteProperty(Uint8Array.prototype, 'toBase64')
    try {
      expect(typeof Uint8Array.prototype.toBase64).not.toBe('function')
      expect(cases.map((bytes) => toB64U(bytes))).toEqual(native)
      expect(native).toEqual(['AQID', 'aGk', 'YQ', '-_8'])
    } finally {
      Object.defineProperty(Uint8Array.prototype, 'toBase64', descriptor)
    }
  })
})
```

The last test is the one that matters: it deletes the native `toBase64`, forces `toB64U` down the `btoa` branch, and asserts the fallback strips padding identically. It restores the original property descriptor in a `finally`, so the deletion cannot leak into other tests even if an assertion throws.

- [ ] **Step 3: Run the tests**

Run: `npx vitest run -t 'atob fallback path'`
Expected: PASS — 5 tests. These characterise behaviour that Tasks 1 and 4 already made correct; they are regression guards, not a red-to-green cycle. **If the encode-fallback test fails, Task 1's fallback branch is wrong** — check that it strips `=` before or after the alphabet swap (either order works, since `=` is not in `+/`).

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS — 61 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/codec/test/lib.test.ts
git commit -m "test(codec): cover the atob fallback path

Node has the native base64 methods, so the fallback branches never ran in
CI. Exercises the *atob helpers directly, and removes the native toBase64 to
prove the encode fallback strips padding identically."
```

---

### Task 6: Changeset, docs check, and full verification

**Files:**
- Create: `.changeset/codec-freeze-fixes.md`
- Verify (do not edit): `docs/reference/validation.md:94,120`, `docs/skills/validation.skill.md:142-143`, `packages/codec/README.md`

**Interfaces:**
- Consumes: all five preceding tasks.
- Produces: the release artifact. `@sozai/codec` 0.1.0 → 0.2.0.

- [ ] **Step 1: Write the changeset**

Create `.changeset/codec-freeze-fixes.md`. Note this is at the **repo root**, not in `packages/codec` — `cd` back to the repo root for this step, then return.

`minor`, not `major`: the package is 0.x, where changesets treats a breaking change as a minor bump. Match the prose style of the existing `.changeset/schema-ajv-fixes.md`.

```markdown
---
"@sozai/codec": minor
---

Fix the freeze-blocking correctness bugs found in the 2026-07-02 audit. All four are breaking behaviour changes, landed together before the package freezes.

- **`toB64U` now emits unpadded base64url.** RFC 7515 (JWS) and RFC 4648 §5 forbid `=` padding; an Ed25519 signature is 64 bytes and `64 % 3 === 1`, so every JWS signature produced through this codec previously ended in `==`. `toB64` remains padded, per RFC 4648 §4. `fromB64U` still accepts padded input — decode stays lenient, so tokens issued before this release keep verifying.
- **`toUTF` now uses a fatal `TextDecoder`.** Invalid UTF-8 throws a `TypeError` instead of decoding to a U+FFFD-mangled string, and the throw propagates through `b64uToUTF` and `b64uToJSON`. This codec sits under signature verification, where silent substitution let corrupted bytes decode to a plausible string.
- **`canonicalStringify` now throws on values with no JSON representation** (`undefined`, functions, symbols) instead of returning `undefined` typed as `string`, which made `b64uFromJSON` silently encode `""`. It is also no longer marked `@internal` — it is imported outside this package.
- **`fromB64` now validates its input.** It previously accepted malformed input — embedded whitespace, base64url characters — and silently decoded it anyway; it now trims surrounding whitespace and throws on anything else malformed, including embedded whitespace. `fromB64` loads private keys from env vars, CLI flags, and files, where a trailing newline is routine; `fromB64U` stays fully strict, since its input is JWT segments off the wire.
```

- [ ] **Step 2: Verify the docs already match**

The repo docs already describe the unpadded contract — they were right and the code was wrong. Confirm, do not edit:

Run: `cd /Users/paul/dev/yulsi/sozai && grep -n 'padding' docs/reference/validation.md docs/skills/validation.skill.md`
Expected: `docs/reference/validation.md:94` says "no padding" for `toB64U`; line 120 shows `// "aGVsbG8" (URL-safe, no padding)`; `docs/skills/validation.skill.md:142-143` says the same. Line 159 correctly says `toB64/fromB64` are "standard Base64 with padding".

If `packages/codec/README.md` documents padded base64url output anywhere, fix it. If it does not mention padding, leave it alone.

- [ ] **Step 3: Run the package's full verification**

Run: `cd packages/codec && npx tsc --noEmit -p tsconfig.test.json && npx vitest run && npx biome check src test`
Expected: typecheck exits 0 with no output; 61 tests pass; biome reports no errors.

- [ ] **Step 4: Confirm nothing else in the repo regressed**

`@sozai/codec` has no in-repo dependents (consumers are downstream repos on published `^` ranges), but confirm rather than assume.

Run: `cd /Users/paul/dev/yulsi/sozai && grep -rn '@sozai/codec' packages/*/package.json`
Expected: no output — no sibling package depends on it. If any package *does* appear, run its test suite before continuing.

- [ ] **Step 5: Commit**

```bash
git add .changeset/codec-freeze-fixes.md
git commit -m "chore(codec): changeset for the freeze-blocker fixes"
```

---

## Done when

- `toB64U` output matches `/^[A-Za-z0-9_-]*$/` — no `=` at any residue length.
- `toB64` output is still padded and its original tests are untouched.
- `fromB64U` still decodes padded input, so pre-existing tokens verify.
- `toUTF`, `canonicalStringify`, and `fromB64` all throw on bad input rather than returning a degraded value.
- All four codec functions feature-detect with `typeof ... === 'function'`.
- 61 tests pass; typecheck and biome are clean.
- A `minor` changeset exists for `@sozai/codec`.
