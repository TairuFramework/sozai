# @sozai/result

## Installation

```sh
npm install @sozai/result
```

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