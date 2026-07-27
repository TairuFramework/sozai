# @sozai/log

Structured logging via [LogTape](https://logtape.org): a one-call setup path and typed re-exports so consumers only need `@sozai/log`.

## Installation

```sh
pnpm add @sozai/log
```

## Usage

```ts
import { getDefaultConfig, getLogger, setup } from '@sozai/log'

// Call once at startup (e.g. in your entry point).
setup(getDefaultConfig())

const logger = getLogger(['myapp', 'server'])
logger.info('listening on {port}', { port: 3000 })
```

Also provides `getSozaiLogger`, `getConsoleSink`, `reset`, … — see [the log reference](../../plugins/sozai/skills/observability/reference/log.md) (part of the `sozai:observability` skill) for the full API.
