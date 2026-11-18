---
"@sozai/hlc": patch
---

`HLC.tryParse` now matches the Rust `sozai-codec` parser: it accepts only the canonical ISO wall time (four-digit or six-digit signed years) with a counter of at least eight digits up to `0xffffffff`, and rejects timestamps whose wall time does not round-trip.
