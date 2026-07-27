# @sozai/log

Thin wrapper over LogTape. Provides a one-call setup path and typed re-exports so consumers only need `@sozai/log`.

## Exports

| Symbol | Kind | Description |
|---|---|---|
| `getLogger` | function | Return a `Logger` scoped to `name` (string or (readonly) category array), optionally pre-bound with `properties`. |
| `getSozaiLogger` | function | Shorthand: `getLogger(['sozai', namespace], properties)`. |
| `getDefaultConfig` | function | Build a minimal `Config` that writes to the console sink at `error` level for both `logtape.meta` and `sozai` categories. Accepts optional `ConsoleSinkOptions`. |
| `setup` | function | Configure LogTape synchronously, applying `getDefaultConfig()` when no argument is given. First call wins: if logging is already configured, logs an error and returns without reconfiguring — call `reset()` first to reconfigure deliberately. |
| `reset` | function | Clear the logging configuration so `setup()` can configure it again. |
| `isSetup` | function | Whether logging has been configured, via `setup()` or otherwise. |
| `getConsoleSink` | function | Re-export from LogTape. Create a console sink directly. |
| `Config` | type | LogTape configuration shape. |
| `ConsoleSinkOptions` | type | Options for the console sink. |
| `Logger` | type | LogTape logger instance. |
| `LogLevel` | type | `'trace' \| 'debug' \| 'info' \| 'warning' \| 'error' \| 'fatal'` |
| `LogRecord` | type | LogTape's log record shape, re-exported so consumers (e.g. `@sozai/otel`'s log sink) don't need a direct `@logtape/logtape` dependency. |

## Example — bootstrap and log

```ts
import { getDefaultConfig, getLogger, setup } from '@sozai/log'

// Call once at startup (e.g. in your entry point).
setup(getDefaultConfig())

const logger = getLogger(['myapp', 'server'])
logger.info('listening on {port}', { port: 3000 })

// For sozai-internal namespaces:
// const logger = getSozaiLogger('runtime', { region: 'eu-1' })
```

`setup` without arguments applies `getDefaultConfig()`, which routes `sozai.*` and `logtape.meta` at `error` level to the console. Pass a custom `Config` to extend categories, sinks, or levels.

## Example: custom config

```ts
import { getConsoleSink, getLogger, setup } from '@sozai/log'

setup({
  sinks: { console: getConsoleSink() },
  loggers: [{ category: ['myapp'], lowestLevel: 'debug', sinks: ['console'] }],
})

const logger = getLogger(['myapp', 'worker'])
logger.debug('subsystem ready')
```

`setup` applies whatever `Config` it is given in place of `getDefaultConfig()` — use this to add
categories, change levels, or route to different sinks.
