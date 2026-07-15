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
  of<V>(value?: V | null): Option<V> {
    return value == null ? Option.none<V>() : Option.some(value as V)
  },
  is<V>(value: unknown): value is Option<V> {
    return value instanceof OptionBase
  },
  from<V>(value: unknown): Option<V> {
    return Option.is<V>(value) ? value : Option.of(value as V)
  },
}
