# log — setup() double-configuration guard + first tests

**Date:** 2026-07-13
**Package:** `@sozai/log`
**Source:** [next/log-setup-guard.md](../../agents/plans/next/log-setup-guard.md) · [audit 2026-07-02 — log](../../agents/plans/completed/2026-07-02-repo-audit.complete.md#log)
**Status:** approved

## Problem

`setup()` (`packages/log/src/index.ts:29-31`) calls logtape's `configureSync`, which throws
`ConfigError` when logging has already been configured. Two independent consumers each calling
`setup()` — a common defensive pattern for a library-facing logging entry point — crash the
process. The package also has no test directory, so nothing guards this or any other behaviour.

## Design

### `setup()` becomes idempotent, and says so

First call wins. A later call is a no-op, but it is not silent: it logs an `error` record on the
`['sozai', 'log']` logger.

```ts
export function setup(maybeConfig?: Config<string, string>): void {
  if (getConfig() != null) {
    getSozaiLogger('log').error('Logging already configured; setup() call ignored')
    return
  }
  configureSync(maybeConfig ?? getDefaultConfig())
}
```

Logging the warning is safe precisely because the guard fired: logtape is configured, so the
record reaches whatever sinks the first caller installed. `getDefaultConfig()` routes the
`['sozai']` category at `error` level, so the message surfaces under the default config. If an
application's own config does not route `sozai` at all, the record is dropped — best-effort
notification, accepted.

Rejected alternatives:

- **Last call wins** (always `resetSync()` then configure): a late library call would clobber the
  application's config. Worse failure mode than the one being fixed.
- **Keep throwing, export `isSetup()`**: leaves the crash reachable for every consumer that
  forgets to guard.
- **Throw when a config argument is explicitly passed**: reintroduces the crash on the exact path
  two configuring consumers would take.

### `reset()` is exported

```ts
export function reset(): void {
  resetSync()
}
```

Wraps logtape's `resetSync`. Two motivations, one mechanism:

- Tests — for this package and for every downstream consumer — need to clear logtape's global
  state between cases, otherwise the first case configures and every later one lands on the
  no-op path.
- It is the escape hatch for intentional reconfiguration: `reset()` then `setup(config)`.

Because `reset()` covers that, `setup()` gets no `force` option and no return value.

`getConfig` and `resetSync` are imported from `@logtape/logtape`. No new error type. All existing
exports (`getLogger`, `getSozaiLogger`, `getDefaultConfig`, the re-exported types and
`getConsoleSink`) are unchanged.

## Test infrastructure

The package has none. Mirror `packages/result`:

- `packages/log/tsconfig.test.json` extending `./tsconfig.json` with `types: ["node"]`,
  `rootDir: "."`, `noEmit: true`, including `./src/**/*` and `./test/**/*`.
- `package.json` scripts: `test:types` gains `-p tsconfig.test.json`; add `test:unit: "vitest run"`;
  `test` becomes `pnpm run test:types && pnpm run test:unit`. No dependency to add — `vitest`
  resolves from the workspace root's `@kigu/dev`, as it does for `result` and `otel`, neither of
  which declares it. `turbo.json` already registers the `test:unit` task.
- `packages/log/test/index.test.ts`.

## Test coverage

`beforeEach(reset)` in every suite, so no case inherits global logtape state.

- `setup()` with no arguments applies `getDefaultConfig()`; `getConfig()` is non-null afterwards.
- A second `setup()` call does not throw, does not replace the existing configuration, and emits
  an `error`-level record. Asserted by having the first call install a memory sink
  (`setup({ sinks: { memory: record => records.push(record) }, loggers: [...] })`) and inspecting
  the captured records.
- `setup(customConfig)` applies that configuration.
- `reset()` clears the configuration (`getConfig()` is null); `setup()` after `reset()` configures
  again.
- `getLogger`: category from a string and from an array; `properties` are attached to emitted
  records.
- `getSozaiLogger`: category is `['sozai', namespace]`; `properties` pass through.
- `getDefaultConfig`: sink and logger shape; `ConsoleSinkOptions` are passed to `getConsoleSink`.

## Release

Changeset: patch bump on `@sozai/log`.

## Out of scope

`@sozai/otel`'s `log-sink.ts` duplicating logtape's `LogRecord` type is tracked separately in
[next/otel-w3c-compliance.md](../../agents/plans/next/otel-w3c-compliance.md).
