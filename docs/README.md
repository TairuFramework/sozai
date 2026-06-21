# Sozai docs

`sozai` (素材 — "raw material") is the core-utilities layer of the stack: stable,
environment-agnostic packages that everything else depends on downward. These docs are
**high-level domain references** — purpose, key exports, and short examples per package.
Detailed per-export API lives in each package's source JSDoc.

The 14 packages are grouped into 5 domains. Each domain has a reference doc (`domains/`)
and an agent skill file (`skills/`, namespace `sozai:*`).

| Domain | Packages | Reference | Skill |
|---|---|---|---|
| Validation | `schema`, `codec` | [domains/validation.md](domains/validation.md) | [skills/validation.skill.md](skills/validation.skill.md) |
| Dataflow | `stream`, `async`, `flow`, `event`, `generator`, `execution` | [domains/dataflow.md](domains/dataflow.md) | [skills/dataflow.skill.md](skills/dataflow.skill.md) |
| Runtime | `runtime`, `runtime-expo` | [domains/runtime.md](domains/runtime.md) | [skills/runtime.skill.md](skills/runtime.skill.md) |
| Observability | `log`, `otel` | [domains/observability.md](domains/observability.md) | [skills/observability.skill.md](skills/observability.skill.md) |
| Primitives | `result`, `patch` | [domains/primitives.md](domains/primitives.md) | [skills/primitives.skill.md](skills/primitives.skill.md) |

All 14 published packages are covered: `async`, `codec`, `event`, `execution`, `flow`,
`generator`, `log`, `otel`, `patch`, `result`, `runtime`, `runtime-expo`, `schema`, `stream`.
