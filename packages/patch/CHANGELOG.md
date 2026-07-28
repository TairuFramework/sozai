# @sozai/patch

## 0.1.3

### Patch Changes

- b47d570: `applyPatches` now round-trips an own `"__proto__"` member instead of dropping it and mutating the
  document's prototype.

  `JSON.parse` produces an own `"__proto__"` data property (it does not invoke the accessor) and
  `structuredClone` preserves it, but the atomic swap ended with `Object.assign(data, working)`, whose
  `[[Set]]` triggered the `__proto__` accessor: the member was silently lost and `data`'s own prototype
  was reassigned to its value — even when no patch referenced it. The swap now re-adds keys via
  `Object.defineProperty` (`[[DefineOwnProperty]]`), so such a document round-trips unchanged. Bounded
  to `data`; the global `Object.prototype` was never reachable. No change for documents without a
  `__proto__` member.

## 0.1.2

### Patch Changes

- 04d6918: `move` with identical `from` and `path` is now a permitted no-op.

  RFC 6902 §4.4 forbids only a _proper_ prefix — a location cannot be moved into one of its own
  descendants — but the guard also rejected an identical `from === path`, throwing `INVALID_PATH`.
  An identical location is not a proper prefix; the RFC permits it and it leaves the document
  unchanged. `move` into an actual descendant (`/a` → `/a/b`) still throws.
