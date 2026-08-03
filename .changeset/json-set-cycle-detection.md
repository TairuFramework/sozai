---
'@sozai/json': patch
---

Make cycle detection O(1) per node in `canonicalize`.

Ancestors were tracked in an array and tested with `Array.prototype.includes`, so every visited node scanned the whole enclosing chain and canonicalization was quadratic in nesting depth. They are tracked in a `Set` now. Measured on a linear chain of nested objects, going from depth 1000 to depth 4000 cost the array 8.3x and the `Set` 4.3x.

No behaviour change. The encoder only ever asks whether a reference is enclosing -- never which one or how deep -- so nothing depended on the array's ordering, and the `Set` keeps the same add-on-enter / remove-on-exit discipline that makes the gate uniform across every object reference. A reference still cannot be added twice: the second attempt is a cycle and throws first.

Nesting depth remains bounded by stack exhaustion rather than by an explicit limit, as before.
