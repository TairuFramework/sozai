---
"@sozai/async": patch
---

`maybeYield()` looks up `defaultYielder.maybeYield` on each call instead of binding it at load, so a spy on `defaultYielder` observes yields from every package that shares the module.
