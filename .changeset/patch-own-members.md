---
"@sozai/patch": patch
---

Path resolution reads only own members of arrays and plain objects, so `getPath` and `setPath` no longer follow inherited or prototype properties. Path segments that are unsafe integers stay string keys, keeping object member names exact, and array indices are validated from the segment text. This matches the Rust `sozai-codec` patch semantics.
