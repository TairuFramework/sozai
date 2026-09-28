---
'@sozai/json': minor
---

Add the `JSONValue` type, a strict `isJSONValue` guard and `canonicalizeJSON`.

`isJSONValue` accepts only values that round-trip through JSON exactly: finite numbers, plain objects and dense arrays, without accessors, symbol keys, `toJSON` or cycles. `canonicalizeJSON` serialises such a value canonically and always returns a string, throwing a `TypeError` otherwise.
