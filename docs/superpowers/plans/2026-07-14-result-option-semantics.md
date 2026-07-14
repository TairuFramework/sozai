# @sozai/result — Error Semantics + Predicate Narrowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks
**Spec:** [2026-07-14-result-option-semantics-design.md](../specs/2026-07-14-result-option-semantics-design.md)

**Goal:** Make `Option`/`Result` narrow correctly in both predicate branches, guarantee `E extends Error` at runtime, and give `map`/`mapError` one semantic that holds sync and async.

**Architecture:** `Option` and `Result` each become a discriminated union of two exported classes over a non-exported abstract base, with the old name surviving as a merged type-alias + statics object. Every catch/rejection path normalizes through `Result.toError`, which gains a cause-receiving factory. `AsyncResult` stays a class (`Execution extends AsyncResult` depends on it) and drops its `Result.from` sniffing on fulfilled paths.

**Tech Stack:** TypeScript (ESM, `#private` fields), vitest, tsc (`test:types`), biome, changesets, pnpm.

## Global Constraints

- Conventions (`AGENTS.md`): `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`; ES `#fields`, never `private`/`readonly`. Never edit `lib/` (generated).
- Run scripts as `rtk proxy pnpm run <script>` or invoke tools directly (`pnpm exec vitest ...`) — a shim otherwise redirects `pnpm run`.
- Package scripts, run from `packages/result` (or `packages/execution`): `pnpm exec vitest run` (unit), `pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json` (types — this compiles `test/**/*`, so **type-level assertions in test files are enforced by CI**).
- The public entry point is `src/index.ts`, which re-exports `*` from all three modules. New exported names (`OKResult`, `ErrorResult`, `SomeOption`, `NoneOption`) are therefore public automatically.
- Breaking release: `@sozai/result` goes `0.1.1` → `0.2.0`. One changeset at the end (Task 7), not per-task.
- **Semantic rule to preserve everywhere:** `map`'s bare return is a **value**, `mapError`'s bare return is an **error**; wrap in `Result.ok` / `Result.error` to say otherwise. No `instanceof Error` sniffing on any `map`/`mapError` path. `Result.from` keeps sniffing and stays the coercion entry point for `unknown`.

---

### Task 1: `Option` becomes a discriminated union

**Files:**
- Modify: `packages/result/src/option.ts` (whole file)
- Test: `packages/result/test/option.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export class SomeOption<V>`, `export class NoneOption<V>`, `export type Option<V> = SomeOption<V> | NoneOption<V>`, `export const Option = { none, some, of, is, from }`. Statics keep today's signatures: `Option.none<V>(): NoneOption<V>`, `Option.some<V>(value: V): SomeOption<V>`, `Option.of<V>(value?: V): Option<V>`, `Option.is<V>(value: unknown): value is Option<V>`, `Option.from<V>(value: unknown): Option<V>`. Instance surface unchanged: `isSome()`, `isNone()`, `orNull`, `orThrow`, `or(defaultValue)`, `map(fn)`. Task 2 uses `Option.some` / `Option.none` and the `Option<V>` type.

- [ ] **Step 1: Write the failing narrowing tests**

Append to `packages/result/test/option.test.ts` (keep the existing `import { Option } from '../src/option.js'`, and add the two new class imports):

```ts
import { describe, expect, test } from 'vitest'

import { NoneOption, Option, SomeOption } from '../src/option.js'

describe('Option narrowing', () => {
  test('the false branch of isSome() is NoneOption, not never', () => {
    const option = Option.of<number>(undefined)
    if (option.isSome()) {
      const value: number = option.value
      expect(value).toBeDefined()
    } else {
      // Before the fix this line does not compile: `option` narrows to `never`,
      // so `test:types` is what actually guards this behavior.
      const none: NoneOption<number> = option
      expect(none.orNull).toBeNull()
    }
  })

  test('the true branch of isSome() is SomeOption', () => {
    const option = Option.of(1)
    if (option.isSome()) {
      const some: SomeOption<number> = option
      expect(some.orNull).toBe(1)
    } else {
      throw new Error('expected some')
    }
  })

  test('isNone() narrows to NoneOption', () => {
    const option = Option.of<string>(null)
    if (option.isNone()) {
      expect(option.orNull).toBeNull()
    } else {
      throw new Error('expected none')
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `packages/result`:
```bash
pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```
Expected: FAIL — `error TS2322: Type 'never' is not assignable to type 'NoneOption<number>'` (the `never`-collapse bug), plus `TS2305`/`TS2724` for the not-yet-exported `SomeOption`/`NoneOption`.

- [ ] **Step 3: Rewrite `option.ts` as a union**

Replace the entire contents of `packages/result/src/option.ts`:

```ts
abstract class OptionBase<V> {
  abstract isSome(): this is SomeOption<V>
  abstract isNone(): this is NoneOption<V>
  abstract get orNull(): V | null
  abstract get orThrow(): V

  or(defaultValue: V): V {
    return this.isSome() ? this.orThrow : defaultValue
  }

  map<U>(fn: (value: V) => U | Option<U>): Option<U> {
    return this.isSome() ? Option.from(fn(this.orThrow)) : (this as unknown as NoneOption<U>)
  }
}

export class SomeOption<V> extends OptionBase<V> {
  #value: V

  constructor(value: V) {
    super()
    this.#value = value
  }

  isSome(): this is SomeOption<V> {
    return true
  }

  isNone(): this is NoneOption<V> {
    return false
  }

  get orNull(): V {
    return this.#value
  }

  get orThrow(): V {
    return this.#value
  }
}

export class NoneOption<V> extends OptionBase<V> {
  isSome(): this is SomeOption<V> {
    return false
  }

  isNone(): this is NoneOption<V> {
    return true
  }

  get orNull(): null {
    return null
  }

  get orThrow(): never {
    throw new Error('Option is none')
  }
}

export type Option<V> = SomeOption<V> | NoneOption<V>

export const Option = {
  none<V>(): NoneOption<V> {
    return new NoneOption<V>()
  },
  some<V>(value: V): SomeOption<V> {
    return new SomeOption<V>(value)
  },
  of<V>(value?: V): Option<V> {
    return value == null ? Option.none<V>() : Option.some(value)
  },
  is<V>(value: unknown): value is Option<V> {
    return value instanceof OptionBase
  },
  from<V>(value: unknown): Option<V> {
    return Option.is<V>(value) ? value : Option.of(value as V)
  },
}
```

Notes for the implementer:
- `Option.map` keeps coercing `null`/`undefined` to `none` via `Option.from` — for `Option`, absence *is* the type's meaning. This is deliberate and is **not** the sniffing the spec removes.
- The old `Option` had a public `constructor(state: OptionState<V>)`. It is gone; nothing in the repo used it.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `packages/result`:
```bash
pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && pnpm exec vitest run test/option.test.ts
```
Expected: types clean; all `option.test.ts` tests PASS. If a pre-existing test asserts on `new Option(...)`, replace it with `Option.some(...)` / `Option.none()`.

- [ ] **Step 5: Commit**

```bash
git add packages/result/src/option.ts packages/result/test/option.test.ts
git commit -m "feat(result)!: Option as a discriminated union of SomeOption | NoneOption"
```

---

### Task 2: `Result` becomes a discriminated union

**Files:**
- Modify: `packages/result/src/result.ts` (whole file)
- Test: `packages/result/test/result.test.ts`

**Interfaces:**
- Consumes: `Option`, `Option.some`, `Option.none` from Task 1.
- Produces: `export class OKResult<V, E extends Error = Error>`, `export class ErrorResult<V, E extends Error = Error>`, `export type Result<V, E extends Error = Error> = OKResult<V, E> | ErrorResult<V, E>`, `export const Result = { ok, error, from, is, toError }`. Statics: `Result.ok<V, E>(value: V): OKResult<V, E>`, `Result.error<V, E>(error: E): ErrorResult<V, E>`, `Result.from<V, E>(value: unknown): Result<V, E>`, `Result.is<V, E>(value: unknown): value is Result<V, E>`, `Result.toError<V, E>(cause: unknown, createError?: () => E): ErrorResult<V, E>` (**the factory stays zero-arg in this task — Task 4 changes it**). Instance surface unchanged: `isOK()`, `isError()`, `value`, `error`, `optional`, `orNull`, `or()`, `map()`, `mapError()`. Tasks 3–6 build on these names.

- [ ] **Step 1: Write the failing narrowing tests**

Append to `packages/result/test/result.test.ts` (add the class imports alongside the existing `Result` import):

```ts
import { ErrorResult, OKResult, Result } from '../src/result.js'

describe('Result narrowing', () => {
  test('the false branch of isOK() is ErrorResult, with a non-nullable error', () => {
    const result = Result.from<number, TypeError>(new TypeError('boom'))
    if (result.isOK()) {
      throw new Error('expected an error result')
    }
    // Before the fix `result.error` is `TypeError | null` here, so this line does
    // not compile — `test:types` is what guards it.
    const error: TypeError = result.error
    expect(error.message).toBe('boom')
    const errored: ErrorResult<number, TypeError> = result
    expect(errored.isError()).toBe(true)
  })

  test('the true branch of isOK() is OKResult, with a null error', () => {
    const result = Result.from<number, TypeError>(1)
    if (result.isError()) {
      throw new Error('expected an OK result')
    }
    const ok: OKResult<number, TypeError> = result
    const value: number = ok.value
    const error: null = ok.error
    expect(value).toBe(1)
    expect(error).toBeNull()
  })

  test('accessing value on an ErrorResult throws the error', () => {
    const error = new TypeError('boom')
    const result = Result.error<number, TypeError>(error)
    expect(() => result.value).toThrow(error)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `packages/result`:
```bash
pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```
Expected: FAIL — `Type 'TypeError | null' is not assignable to type 'TypeError'`, plus missing exports `OKResult` / `ErrorResult`.

- [ ] **Step 3: Rewrite `result.ts` as a union**

Replace the entire contents of `packages/result/src/result.ts`:

```ts
import { Option } from './option.js'

abstract class ResultBase<V, E extends Error> {
  #optional?: Option<V>

  abstract isOK(): this is OKResult<V, E>
  abstract isError(): this is ErrorResult<V, E>
  abstract get error(): E | null
  abstract get value(): V

  get optional(): Option<V> {
    if (this.#optional == null) {
      this.#optional = this.isOK() ? Option.some(this.value) : Option.none<V>()
    }
    return this.#optional
  }

  get orNull(): V | null {
    return this.isOK() ? this.value : null
  }

  or(defaultValue: V): V {
    return this.isOK() ? this.value : defaultValue
  }

  map<OutV, OutE extends Error = Error>(
    fn: (value: V) => OutV | Result<OutV, OutE>,
  ): Result<OutV, E | OutE> {
    if (this.isError()) {
      return this as unknown as ErrorResult<OutV, E>
    }

    try {
      const result = fn(this.value)
      return Result.is<OutV, OutE>(result) ? result : Result.ok<OutV, OutE>(result)
    } catch (cause) {
      return Result.toError<OutV, OutE>(cause)
    }
  }

  mapError<OutE extends Error = Error>(
    fn: (error: E) => OutE | Result<V, OutE>,
  ): Result<V, E | OutE> {
    if (this.isOK()) {
      return this as unknown as OKResult<V, E>
    }

    try {
      const result = fn(this.error as E)
      return Result.is<V, OutE>(result) ? result : Result.error<V, OutE>(result)
    } catch (cause) {
      return Result.toError<V, OutE>(cause)
    }
  }
}

export class OKResult<V, E extends Error = Error> extends ResultBase<V, E> {
  #value: V

  constructor(value: V) {
    super()
    this.#value = value
  }

  isOK(): this is OKResult<V, E> {
    return true
  }

  isError(): this is ErrorResult<V, E> {
    return false
  }

  get error(): null {
    return null
  }

  get value(): V {
    return this.#value
  }
}

export class ErrorResult<V, E extends Error = Error> extends ResultBase<V, E> {
  #error: E

  constructor(error: E) {
    super()
    this.#error = error
  }

  isOK(): this is OKResult<V, E> {
    return false
  }

  isError(): this is ErrorResult<V, E> {
    return true
  }

  get error(): E {
    return this.#error
  }

  get value(): never {
    throw this.#error
  }
}

export type Result<V, E extends Error = Error> = OKResult<V, E> | ErrorResult<V, E>

export const Result = {
  ok<V, E extends Error = Error>(value: V): OKResult<V, E> {
    return new OKResult<V, E>(value)
  },
  error<V, E extends Error = Error>(error: E): ErrorResult<V, E> {
    return new ErrorResult<V, E>(error)
  },
  is<V, E extends Error = Error>(value: unknown): value is Result<V, E> {
    return value instanceof ResultBase
  },
  from<V, E extends Error = Error>(value: unknown): Result<V, E> {
    return Result.is<V, E>(value)
      ? value
      : value instanceof Error
        ? Result.error<V, E>(value as E)
        : Result.ok<V, E>(value as V)
  },
  toError<V, E extends Error = Error>(cause: unknown, createError?: () => E): ErrorResult<V, E> {
    const error =
      cause instanceof Error
        ? cause
        : createError
          ? createError()
          : new Error('Unknown error', { cause })
    return Result.error<V, E>(error as E)
  },
}
```

Notes for the implementer:
- The `map`/`mapError` catch blocks now go through `Result.toError` — that is Task 3's *behavior* fix, landed here only because rewriting the file makes leaving the old broken catch in place pointless. Task 3 adds the tests that pin it.
- `mapError` no longer calls `Result.from` (which sniffed `instanceof Error`). A bare return is now unconditionally the replacement error, per the global semantic rule.
- `Result.toError` keeps its zero-arg factory here. Task 4 changes it — do not change it early.

- [ ] **Step 4: Run the full package tests**

Run from `packages/result`:
```bash
pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && pnpm exec vitest run
```
Expected: types clean; all tests PASS. Existing tests that construct via `new Result(...)` must be rewritten to `Result.ok(...)` / `Result.error(...)`. `async-result.test.ts` may still fail here — that is expected and is Task 4's job **only** if the failure is a type error from `AsyncResult`'s own code; a *runtime* failure in `async-result.test.ts` at this point means `Result` was broken, so fix it here.

- [ ] **Step 5: Commit**

```bash
git add packages/result/src/result.ts packages/result/test/result.test.ts
git commit -m "feat(result)!: Result as a discriminated union of OKResult | ErrorResult"
```

---

### Task 3: Pin the throw-normalization behavior in `Result`

**Files:**
- Test: `packages/result/test/result.test.ts`
- Modify (only if a test fails): `packages/result/src/result.ts`

**Interfaces:**
- Consumes: `Result.ok`, `Result.error`, `Result.toError`, `map`, `mapError` from Task 2.
- Produces: no new API. Locks in: a thrown non-`Error` in `map` or `mapError` yields an `ErrorResult` whose `error` is a real `Error` with the thrown value as `cause`.

- [ ] **Step 1: Write the tests**

Append to `packages/result/test/result.test.ts`:

```ts
describe('Result throw normalization', () => {
  test('a non-Error thrown in map becomes a normalized Error', () => {
    const result = Result.ok<number>(1).map(() => {
      throw 'oops'
    })
    expect(result.isError()).toBe(true)
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error?.cause).toBe('oops')
  })

  test('a non-Error thrown in mapError stays an error and does not become OK', () => {
    const result = Result.error<number>(new Error('first')).mapError(() => {
      throw 'oops'
    })
    // Regression: this used to route through Result.from and yield isOK() === true.
    expect(result.isOK()).toBe(false)
    expect(result.isError()).toBe(true)
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error?.cause).toBe('oops')
  })

  test('an Error thrown in map is preserved as-is', () => {
    const thrown = new TypeError('boom')
    const result = Result.ok<number>(1).map(() => {
      throw thrown
    })
    expect(result.error).toBe(thrown)
  })

  test('map returning a bare Error keeps it as an OK value', () => {
    const value = new Error('carried')
    const result = Result.ok<number>(1).map(() => value)
    expect(result.isOK()).toBe(true)
    expect(result.value).toBe(value)
  })

  test('mapError returning a bare Error replaces the error', () => {
    const replacement = new TypeError('replaced')
    const result = Result.error<number>(new Error('first')).mapError(() => replacement)
    expect(result.isError()).toBe(true)
    expect(result.error).toBe(replacement)
  })

  test('mapError recovers when the callback returns Result.ok', () => {
    const result = Result.error<number>(new Error('first')).mapError(() => Result.ok<number>(2))
    expect(result.isOK()).toBe(true)
    expect(result.value).toBe(2)
  })
})
```

- [ ] **Step 2: Run the tests**

Run from `packages/result`:
```bash
pnpm exec vitest run test/result.test.ts
```
Expected: PASS — Task 2's rewrite already implements this behavior. If any test fails, the implementation is wrong, not the test: fix `src/result.ts` so both catch blocks call `Result.toError(cause)` and `mapError`'s success path calls `Result.error(result)` for a bare return.

- [ ] **Step 3: Commit**

```bash
git add packages/result/test/result.test.ts packages/result/src/result.ts
git commit -m "test(result): pin throw normalization and bare-return semantics in map/mapError"
```

---

### Task 4: `Result.toError` gains a cause-receiving factory

**Files:**
- Modify: `packages/result/src/result.ts` (the `toError` static)
- Test: `packages/result/test/result.test.ts`

**Interfaces:**
- Consumes: `Result.toError` from Task 2.
- Produces: `Result.toError<V, E extends Error = Error>(cause: unknown, createError?: (cause: unknown) => E): ErrorResult<V, E>` — when `createError` is provided it **always** runs, including for `Error` causes, and receives the cause. Task 6 (`@sozai/execution`) depends on this exact signature.

- [ ] **Step 1: Write the failing tests**

Append to `packages/result/test/result.test.ts`:

```ts
describe('Result.toError factory', () => {
  class DomainError extends Error {}

  test('the factory runs for an Error cause and receives it', () => {
    const cause = new TypeError('underlying')
    const result = Result.toError<number, DomainError>(
      cause,
      (received) => new DomainError('wrapped', { cause: received }),
    )
    // Before the fix the factory was skipped entirely for Error causes.
    expect(result.error).toBeInstanceOf(DomainError)
    expect(result.error.cause).toBe(cause)
  })

  test('the factory runs for a non-Error cause and receives it', () => {
    const result = Result.toError<number, DomainError>(
      'oops',
      (received) => new DomainError('wrapped', { cause: received }),
    )
    expect(result.error).toBeInstanceOf(DomainError)
    expect(result.error.cause).toBe('oops')
  })

  test('without a factory, an Error cause passes through', () => {
    const cause = new TypeError('underlying')
    expect(Result.toError(cause).error).toBe(cause)
  })

  test('without a factory, a non-Error cause is wrapped', () => {
    const result = Result.toError('oops')
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toBe('Unknown error')
    expect(result.error.cause).toBe('oops')
  })
})
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run from `packages/result`:
```bash
pnpm exec vitest run test/result.test.ts -t 'factory runs for an Error cause'
```
Expected: FAIL — `expected Error to be an instance of DomainError` (the factory is skipped for `Error` causes today).

- [ ] **Step 3: Rewrite the `toError` static**

In `packages/result/src/result.ts`, replace the `toError` entry of the `Result` object:

```ts
  toError<V, E extends Error = Error>(
    cause: unknown,
    createError?: (cause: unknown) => E,
  ): ErrorResult<V, E> {
    const error = createError
      ? createError(cause)
      : cause instanceof Error
        ? cause
        : new Error('Unknown error', { cause })
    return Result.error<V, E>(error as E)
  },
```

- [ ] **Step 4: Run the full package tests**

Run from `packages/result`:
```bash
pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && pnpm exec vitest run
```
Expected: types clean; all tests PASS. Existing zero-arg factories (`() => new Foo()`) stay assignable to `(cause: unknown) => E` and keep compiling.

- [ ] **Step 5: Commit**

```bash
git add packages/result/src/result.ts packages/result/test/result.test.ts
git commit -m "feat(result)!: Result.toError factory always wins and receives the cause"
```

---

### Task 5: `AsyncResult` — normalization, rule A, dead code

**Files:**
- Modify: `packages/result/src/async-result.ts`
- Test: `packages/result/test/async-result.test.ts`

**Interfaces:**
- Consumes: `Result`, `OKResult`, `ErrorResult`, `Result.toError` (Task 4 signature).
- Produces: `AsyncResult` stays a `class` with the same construction surface (`new AsyncResult(promise)`, `AsyncResult.ok/error/from/resolve/all/is`), so `Execution extends AsyncResult` keeps working. Changed: `MappedResult` is now only used by `map`; `mapError`'s callback type becomes `(error: E) => OutE | Result<V, OutE> | PromiseLike<Result<V, OutE>> | AsyncResult<V, OutE>`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/result/test/async-result.test.ts`:

```ts
describe('AsyncResult semantics', () => {
  test('a non-Error thrown in map becomes a normalized Error', async () => {
    const result = await AsyncResult.ok<number>(1).map(() => {
      throw 'oops'
    })
    expect(result.isError()).toBe(true)
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error?.cause).toBe('oops')
  })

  test('a non-Error thrown in mapError stays an error', async () => {
    const result = await AsyncResult.error<number>(new Error('first')).mapError(() => {
      throw 'oops'
    })
    expect(result.isOK()).toBe(false)
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error?.cause).toBe('oops')
  })

  test('map returning a bare Error keeps it as an OK value, like the sync Result', async () => {
    const value = new Error('carried')
    const result = await AsyncResult.ok<number>(1).map(() => value)
    // Previously this routed through Result.from and became an error Result.
    expect(result.isOK()).toBe(true)
    expect(result.value).toBe(value)
  })

  test('mapError returning a bare Error replaces the error', async () => {
    const replacement = new TypeError('replaced')
    const result = await AsyncResult.error<number>(new Error('first')).mapError(() => replacement)
    expect(result.isError()).toBe(true)
    expect(result.error).toBe(replacement)
  })

  test('mapError recovers when the callback returns AsyncResult.ok', async () => {
    const result = await AsyncResult.error<number>(new Error('first')).mapError(() =>
      AsyncResult.ok<number>(2),
    )
    expect(result.isOK()).toBe(true)
    expect(result.value).toBe(2)
  })

  test('all() normalizes non-Error rejection reasons', async () => {
    const results = await AsyncResult.all<number>([Promise.resolve(1), Promise.reject('oops')])
    expect(results.value[0].isOK()).toBe(true)
    const errored = results.value[1]
    expect(errored.isError()).toBe(true)
    expect(errored.error).toBeInstanceOf(Error)
    expect(errored.error?.cause).toBe('oops')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `packages/result`:
```bash
pnpm exec vitest run test/async-result.test.ts
```
Expected: FAIL — at minimum `all() normalizes non-Error rejection reasons` (`expected 'oops' to be an instance of Error`) and `map returning a bare Error keeps it as an OK value` (`expected false to be true`).

- [ ] **Step 3: Apply the four changes to `async-result.ts`**

1. Delete the dead species declaration (`AsyncResult` is not a `Promise` subclass, so it has no effect):

```ts
// DELETE this line:
  static [Symbol.species] = Promise
```

2. Normalize rejection reasons in `all`:

```ts
  static all<V, E extends Error = Error>(
    values: Iterable<V | PromiseLike<V>>,
  ): AsyncResult<Array<Result<V, E>>, never> {
    const inputs = Array.from(values).map((value) => toPromise(() => value))
    const promise = Promise.allSettled(inputs).then((results) => {
      return results.map((result) => {
        return result.status === 'fulfilled'
          ? Result.ok<V, E>(result.value)
          : Result.toError<V, E>(result.reason)
      })
    })
    return AsyncResult.resolve(promise)
  }
```

3. Stop sniffing on `map`'s fulfilled path — a returned value is a value:

```ts
  map<OutV, OutE extends Error = Error>(
    fn: (value: V) => MappedResult<OutV, OutE>,
  ): AsyncResult<OutV, E | OutE> {
    return new AsyncResult(
      this.#promise.then((self) => {
        if (self.isError()) {
          return self as unknown as Result<OutV, E | OutE>
        }
        return toPromise(() => fn(self.value))
          .then((result) =>
            Result.is<OutV, OutE>(result) ? result : Result.ok<OutV, OutE>(result as OutV),
          )
          .catch(Result.toError<OutV, OutE>)
      }),
    )
  }
```

4. Retype `mapError` and make a bare return the replacement error (aligning async to sync):

```ts
  mapError<OutE extends Error = Error>(
    fn: (
      error: E,
    ) => OutE | Result<V, OutE> | PromiseLike<Result<V, OutE>> | AsyncResult<V, OutE>,
  ): AsyncResult<V, E | OutE> {
    return new AsyncResult(
      this.#promise.then((self) => {
        if (self.isOK()) {
          return self as unknown as Result<V, E | OutE>
        }
        return toPromise(() => fn(self.error as E))
          .then((result) =>
            Result.is<V, OutE>(result) ? result : Result.error<V, OutE>(result as OutE),
          )
          .catch(Result.toError<V, OutE>)
      }),
    )
  }
```

Note: `Result.toError` is passed directly to `.catch`, which calls it with one argument (the reason). That matches its `(cause, createError?)` signature — the second parameter stays `undefined`.

- [ ] **Step 4: Run the full package tests**

Run from `packages/result`:
```bash
pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && pnpm exec vitest run
```
Expected: types clean; all tests PASS. Any pre-existing `async-result.test.ts` case asserting that a bare `Error` returned from `map` produces an *error* Result is now testing the old semantic — update it to assert `isOK()` and reference the spec's rule A in the test name.

- [ ] **Step 5: Commit**

```bash
git add packages/result/src/async-result.ts packages/result/test/async-result.test.ts
git commit -m "feat(result)!: AsyncResult adopts sync map/mapError semantics, normalizes throws"
```

---

### Task 6: Update `@sozai/execution` for the new surface

**Files:**
- Modify: `packages/execution/src/execution.ts` (lines ~106, ~117, ~230, ~267)
- Test: `packages/execution/test/execution.test.ts` (only if a case fails)

**Interfaces:**
- Consumes: everything from Tasks 1–5 — the `Result` union, narrowing predicates, and the `(cause: unknown) => E` factory.
- Produces: no API change to `@sozai/execution`. Its observable behavior must be **identical** to before.

- [ ] **Step 1: Restate Error pass-through at every `toError` call site**

All three sites pass a factory *and* rely on today's rule that an `Error` cause silently bypasses it. Now that the factory always wins, each must say so explicitly or a user's error gets re-wrapped — a silent regression.

`packages/execution/src/execution.ts` ~line 106 (abort handling):
```ts
      unsubscribeAbort = onAbort(signal, () => {
        settle(
          Result.toError<V, E | Interruption>(signal.reason, (cause) =>
            cause instanceof Error ? (cause as E) : new AbortInterruption({ cause }),
          ),
        )
      })
```

~line 116 (execute rejection):
```ts
        toPromise(() => ctx.execute(signal))
          .then(Result.from<V, E | Interruption>, (cause) => {
            return Result.toError<V, E | Interruption>(cause, (received) =>
              received instanceof Error
                ? (received as E)
                : (new Error('Execution failed', { cause: received }) as E),
            )
          })
```

~line 230 (`next` callback throw):
```ts
      } catch (cause) {
        const errored = Result.toError<V | OutV, E | OutE | Interruption>(cause, (received) =>
          received instanceof Error
            ? (received as OutE)
            : (new Error('Execution failed', { cause: received }) as OutE),
        )
```

Leave the `.then(Result.from<V, E | Interruption>)` on the *fulfilled* path alone — whether an `Executable` returning an `Error` means failure is `@sozai/execution`'s own semantic, out of scope here.

- [ ] **Step 2: Delete the now-unnecessary cast in `ifError`**

`packages/execution/src/execution.ts` ~line 267 — `result.error` is `E | Interruption` inside the `isError()` branch now that narrowing works:

```ts
  ifError<OutV, OutE extends Error = Error>(
    fn: (error: E | Interruption) => Executable<OutV, OutE> | null,
  ): Execution<V | OutV, E | OutE> {
    return this.next((result) => (result.isError() ? fn(result.error) : null))
  }
```

- [ ] **Step 3: Run the execution package tests**

Run from `packages/execution`:
```bash
pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && pnpm exec vitest run
```
Expected: types clean; all tests PASS with no test-file edits. A failure here means behavior drifted — most likely a `toError` factory that no longer passes `Error` causes through. Fix the source, not the test. Only edit `execution.test.ts` if a case constructs `new Result(...)` directly (use `Result.ok` / `Result.error` instead).

- [ ] **Step 4: Commit**

```bash
git add packages/execution/src/execution.ts packages/execution/test/execution.test.ts
git commit -m "fix(execution): adapt to @sozai/result narrowing and toError factory"
```

---

### Task 7: Docs, changeset, whole-repo verification

**Files:**
- Modify: `packages/result/README.md`
- Create: `.changeset/<any-name>.md`
- Delete: `docs/agents/plans/next/result-option-semantics.md`

**Interfaces:**
- Consumes: the finished implementation.
- Produces: the release artifact.

- [ ] **Step 1: Document the semantics in the README**

`packages/result/README.md` is currently install-only. Append:

````markdown
## Semantics

`Result<V, E>` is a union of `OKResult<V, E> | ErrorResult<V, E>`, so `isOK()` / `isError()`
narrow **both** branches — inside `if (result.isError())`, `result.error` is `E`, not `E | null`.
`Option<V>` is `SomeOption<V> | NoneOption<V>` and narrows the same way. Construct via the
statics (`Result.ok`, `Result.error`, `Option.some`, `Option.of`), never with `new`.

**A returned value is a value; only a throw or an explicit error makes an error Result.**

```ts
Result.ok(1).map(() => new Error('x'))        // ok(Error) — a returned value is a value
Result.ok(1).map(() => { throw 'oops' })      // error(Error('Unknown error', { cause: 'oops' }))
Result.error(e).mapError(() => new Other())   // error(Other) — mapError's bare return is an error
Result.error(e).mapError(() => Result.ok(1))  // ok(1) — recover explicitly
```

The same rules hold for `AsyncResult`. Anything thrown or rejected is normalized through
`Result.toError`, so a Result's `error` is always a real `Error` — a thrown non-`Error` becomes
`new Error('Unknown error', { cause })`. Pass a factory to override the wrapping, including for
`Error` causes:

```ts
Result.toError(cause, (cause) => new DomainError('failed', { cause }))
```
````

- [ ] **Step 2: Write the changeset**

Create `.changeset/result-option-semantics.md`:

```markdown
---
'@sozai/result': minor
'@sozai/execution': patch
---

`Result` and `Option` are now discriminated unions (`OKResult | ErrorResult`,
`SomeOption | NoneOption`), so `isOK()`/`isError()`/`isSome()`/`isNone()` narrow both branches —
`error` is non-nullable inside an `isError()` branch, and the false branch of `isSome()` no longer
collapses to `never`.

**Breaking:** `new Result(...)` / `new Option(...)` are gone (use the statics), and `x instanceof
Result` no longer works (use `Result.is(x)`).

**Breaking:** one semantic now holds sync and async — `map`'s bare return is a value, `mapError`'s
bare return is an error, and nothing sniffs `instanceof Error` in between. `AsyncResult.map`
returning a bare `Error` is now an OK Result carrying it, not an error Result.

**Fixed:** a non-`Error` thrown inside `mapError` produced a *success* Result. Every throw and
rejection (including `AsyncResult.all`'s) now normalizes through `Result.toError`, so `error` is
always a real `Error`.

`Result.toError`'s factory now receives the cause and always wins, including for `Error` causes,
so failures can be wrapped in domain errors.
```

- [ ] **Step 3: Verify the whole repo**

Run from the repo root:
```bash
rtk proxy pnpm run test && pnpm exec biome check ./packages
```
Expected: every package's `test:types` and `test:unit` PASS; biome clean. Fix anything that fails before committing.

- [ ] **Step 4: Retire the backlog item**

The `next/` item is superseded by the spec and this plan:
```bash
git rm docs/agents/plans/next/result-option-semantics.md
```

- [ ] **Step 5: Commit**

```bash
git add packages/result/README.md .changeset/result-option-semantics.md
git commit -m "docs(result): document error semantics; changeset for 0.2.0"
```

---

## Verification

The work is done when, from the repo root, `rtk proxy pnpm run test` and `pnpm exec biome check ./packages` are both clean, and:

- `if (!option.isSome())` compiles with `option` as `NoneOption<V>` (not `never`).
- `if (result.isError())` gives `result.error` type `E` (not `E | null`), with no cast in `@sozai/execution`.
- `Result.error(e).mapError(() => { throw 'oops' })` yields `isError() === true`.
- `Result.ok(1).map(() => new Error('x'))` and `AsyncResult.ok(1).map(() => new Error('x'))` both yield `isOK() === true`.
- `@sozai/execution`'s tests pass **unmodified** except for constructor call sites.
