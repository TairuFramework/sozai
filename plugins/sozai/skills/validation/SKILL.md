---
name: validation
description: Use when validating data against JSON Schema or encoding and decoding messages in sozai.
---

# Sozai validation

Schema validation and encoding. JSON Schema with compile-time type generation, plus the
encoding and decoding primitives that move validated values across a boundary.

## Packages

- **@sozai/schema** — JSON Schema validation with type generation (`Schema`, `FromSchema`). → `reference/schema.md`
- **@sozai/codec** — encoding and decoding primitives. → `reference/codec.md`
- **@sozai/json** — canonical JSON and hardened parsing. → `reference/json.md`

## Pick this when

Use `@sozai/schema` to:

- Validate untrusted input — user data, config files, deserialized payloads
- Derive a TypeScript type from a single schema definition (`FromSchema`)
- Enforce both compile-time and runtime type safety from one definition
- Integrate with the Standard Schema v1 ecosystem
- Collect all validation errors in one pass rather than fail-fast

Use `@sozai/codec` to:

- Encode binary data for transmission in JSON or URLs
- Convert between UTF-8 strings and byte arrays
- Produce deterministic JSON for content addressing or signatures
- Round-trip objects through Base64URL without manual JSON steps

Use `@sozai/json` to:

- Produce byte-identical JSON for signing or content addressing
- Parse untrusted JSON with a nesting limit
- Defend a merge site against prototype-polluting keys

## Related

- `/sozai:dataflow` — `@sozai/flow` builds on `@sozai/schema`.

`@sozai/codec` depends on `@sozai/json`; nothing else in this repo depends on either.
