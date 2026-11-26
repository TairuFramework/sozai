# @sozai/hlc

## 0.1.2

### Patch Changes

- Add injectable wall and monotonic runtime clocks and an optional physical clock for HLC.

## 0.1.1

### Patch Changes

- `HLC.tryParse` now matches the Rust `sozai-codec` parser: it accepts only the canonical ISO wall time (four-digit or six-digit signed years) with a counter of at least eight digits up to `0xffffffff`, and rejects timestamps whose wall time does not round-trip.

## 0.1.0

### Minor Changes

- First release of @sozai/hlc: a dependency-free hybrid logical clock with sortable timestamps, parsing, comparison, and a local mint hook.
