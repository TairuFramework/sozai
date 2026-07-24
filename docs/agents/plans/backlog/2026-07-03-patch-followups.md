# @sozai/patch — deferred follow-up: atomic-swap prototype hardening

**Status:** open · backlog · no freeze dependency · deliberately deferred
**Source:** deferred minor from [completed/2026-07-03-patch-rfc6902-compliance](../completed/2026-07-03-patch-rfc6902-compliance.complete.md).
The docs, coverage, and RFC `move`-identical-path items from this file were done on
[2026-07-24](../completed/2026-07-24-patch-followups-docs-coverage.complete.md); only this one remains.

## Atomic swap prototype hardening

`applyPatches`' clone-and-swap ends with `Object.assign(data, working)`. If `data` carried an own
`"__proto__"` key (e.g. from `JSON.parse` of untrusted input at a higher layer), `structuredClone`
preserves it and `Object.assign`'s `[[Set]]` could reassign `data`'s own `[[Prototype]]`. Bounded to
the caller's `data` object (NOT global `Object.prototype`), and the value originates from `data`
itself — theoretical.

Left untouched deliberately to avoid risking the well-tested atomic swap. Fix if desired: rebuild via
`Reflect.ownKeys` + `Object.defineProperty` (uses `[[DefineOwnProperty]]`, not `[[Set]]`), which also
round-trips such keys correctly.

## Why still deferred

No known consumer feeds untrusted input through `applyPatches` at a layer that would carry an own
`__proto__` key, and the guard would touch the one code path the RFC-compliance work most carefully
verified. Pick up only with a concrete reason to break into the swap.
