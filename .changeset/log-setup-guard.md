---
"@sozai/log": patch
---

`setup()` no longer throws when logging is already configured.

Previously `setup()` called logtape's `configureSync` unguarded, which throws `ConfigError` on a second call — two independent consumers each calling `setup()` crashed the process. The first call now wins: a later call logs an `error` record on the `['sozai', 'log']` logger (reaching whatever sinks the first caller installed) and returns without reconfiguring.

Also adds `reset()`, which wraps logtape's `resetSync()`. It is the escape hatch for deliberate reconfiguration — `reset()` then `setup(config)` — and the way test suites clear logtape's process-global state between cases.

This is the package's first release with tests.
