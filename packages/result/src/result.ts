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
}
