---
'@sozai/patch': patch
---

`applyPatches` now round-trips an own `"__proto__"` member instead of dropping it and mutating the
document's prototype.

`JSON.parse` produces an own `"__proto__"` data property (it does not invoke the accessor) and
`structuredClone` preserves it, but the atomic swap ended with `Object.assign(data, working)`, whose
`[[Set]]` triggered the `__proto__` accessor: the member was silently lost and `data`'s own prototype
was reassigned to its value — even when no patch referenced it. The swap now re-adds keys via
`Object.defineProperty` (`[[DefineOwnProperty]]`), so such a document round-trips unchanged. Bounded
to `data`; the global `Object.prototype` was never reachable. No change for documents without a
`__proto__` member.
