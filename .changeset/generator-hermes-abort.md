---
"@sozai/generator": patch
---

`consume()` recognises AbortError reasons without requiring a DOMException global, preventing aborts from hanging on Hermes. AbortInterruption preserves the original reason as its cause.
