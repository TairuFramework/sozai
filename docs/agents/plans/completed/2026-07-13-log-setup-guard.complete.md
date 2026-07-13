# log — setup() double-configuration guard + first tests

**Status:** complete · 2026-07-13
**Package:** `@sozai/log` (patch)
**Source:** [audit 2026-07-02 — log](2026-07-02-repo-audit.complete.md#log) (freeze-blocker, priority 9)

## Goal

`setup()` called logtape's `configureSync` unguarded, which throws `ConfigError` when logging
is already configured — two independent consumers each calling `setup()` crashed the process.
The package also had no tests at all.

## What was built

`setup()` is now idempotent, `reset()` and `isSetup()` are exported, and the package has its
first test suite (18 tests: vitest, `tsconfig.test.json`, `test:unit` script, mirroring
`packages/result`). `vitest` needs no dependency entry — it resolves from the workspace root's
`@kigu/dev`.

Final public surface:

```ts
setup(maybeConfig?: Config<string, string>): void  // first call wins
reset(): void                                      // clears configuration
isSetup(): boolean                                 // getConfig() != null
getLogger / getSozaiLogger / getDefaultConfig / getConsoleSink  // unchanged
```

## Design decisions

- **First call wins; a later `setup()` is a no-op that logs an `error` record** on the
  `['sozai', 'log']` logger. Logging the notification is safe precisely because the guard fired:
  logtape is configured, so the record reaches the sinks the first caller installed. Under
  `getDefaultConfig()` the `['sozai']` category is routed at `error`, so it surfaces. If an
  application's own config does not route `sozai` at all, the record is dropped — best-effort
  notification, accepted.
- **Rejected: last-call-wins** (always `resetSync()` then configure). A late library call would
  clobber the application's config — a worse failure mode than the crash being fixed.
- **Rejected: keep throwing, export `isSetup()` as the caller's guard.** Leaves the crash
  reachable for every consumer that forgets to guard. (`isSetup()` was later added anyway, as a
  *complement* to the guard rather than a substitute: post-guard, a consumer with no way to ask
  whether its config won would have to import `getConfig` from `@logtape/logtape` directly,
  defeating the wrapper.)
- **Rejected: a `force` option on `setup()`.** Deliberate reconfiguration is `reset()` then
  `setup(config)`. `setup()` therefore has no return value and no options beyond the config.
- **The guard checks `getConfig()` before calling `configureSync`**, not after catching its
  error. This also closes a logtape loophole: `configureSync` only throws when the *incoming*
  config does not set `reset: true`, so a caller could otherwise have force-reconfigured through
  `setup()`. The trade-off is that `reset: true` on a config passed to a *second* `setup()` call
  is silently swallowed — documented in `setup()`'s JSDoc.
- **`reset()` wraps logtape's sync `resetSync()`, not its async `reset()`.** Coherent because
  `setup()` wraps `configureSync`, which throws on async sinks — nothing configured through this
  package can install one. Noted in the JSDoc for anyone who bypassed `setup()`.
- **`patch`, not `minor`, despite `reset()`/`isSetup()` being new API.** On 0.x, npm's caret
  pins the minor (`^0.1.0` := `>=0.1.0 <0.2.0`), so a 0.2.0 would strand every downstream on a
  *crash fix* until they widened their ranges. The new exports are purely additive.

## Testing

18 tests covering: the guard (no throw, first config retained, error record emitted, and the
notification surfacing through `getDefaultConfig()`'s own console sink — the path real consumers
hit); `reset()` and `isSetup()`; and characterisation of the previously untested `getLogger`,
`getSozaiLogger` and `getDefaultConfig`. Every suite uses `beforeEach(reset)` — logtape's
configuration is process-global, so without it the first case to configure would leave every
later one on the no-op path.

## Known gap

The `['sozai']` routing in `getDefaultConfig()` is what makes the double-setup notification
visible under the default config. A test now pins that coupling, so re-levelling or dropping
that logger will fail loudly rather than silently muting the notification.
