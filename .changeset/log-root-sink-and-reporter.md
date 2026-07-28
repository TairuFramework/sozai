---
'@sozai/log': minor
---

`getDefaultConfig()` now carries a single root logger, so any category reaches the console at
`error` unless an app deliberately narrows it. Previously its loggers covered `['logtape', 'meta']`
and `['sozai']` only: an app calling `setup()` with no argument — the documented easy path —
configured logging that dropped every other package's records. `isSetup()` answered true, so
consumers' console fallbacks stayed out of the way, and the record went nowhere.

The root entry **replaces** those two rather than joining them. `parentSinks` defaults to
`'inherit'`, which unions a category's own sinks with its parent's without de-duplicating by sink
identity, so keeping either beside a root entry naming the same sink would print every record under
it twice. Behaviour for `['sozai']` and `['logtape', 'meta']` is unchanged: same level, same sink,
once.

**This is a behaviour change for every consumer of the default config, not only the one that
found it.** Any dependency logging to logtape under any category now prints its errors. Bounded
to `error` — `info` and `warn` under an unconfigured category are still dropped — and any app can
narrow a category back with `parentSinks: 'override'`.

New `getReporter(category, packageName)` returns an error reporter that always lands somewhere:
the logger for `category` when logging is configured, a console line tagged with `packageName`
when it is not. `error` level only, since `warn` is dropped by the default config. Consumers
hand-rolling this pair of branches should adopt it.
