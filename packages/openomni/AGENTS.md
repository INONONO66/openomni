# packages/openomni

Orchestration layer for `@openomni/openomni`. It builds on `@openomni/agent` to add plan generation, DAG scheduling, and inbound event handling.

## Module Map

| Domain | Purpose | Key exports |
| --- | --- | --- |
| `src/plan/` | LLM-driven plan generation and gating | `PlanAgent`, `PlanPipeline`, `PlanStore`, `Hashline`, `StructuralGate` |
| `src/dag/` | Pure dependency-graph utilities | `DAG` |
| `src/ingress/` | Inbound event to mode dispatch | `IngressEngine` |
| `src/storage/` | Task persistence adapter layer | `TaskStorage`, `FileTaskStore`, `TaskStore`, `InMemoryTaskStore` |

## Architecture

`src/dag/` is structural only. It knows step topology, not runtime state.

`src/plan/` turns a goal into a structured `Plan`, then runs validation gates before the result is handed off.

`src/ingress/` is the entry path for inbound events. It resolves session context, projects the event into stored state, then chooses the execution mode.

`src/storage/` owns task persistence. The package exports a global storage adapter and a file-backed implementation for durable CLI use.

WHY: each domain stays small and focused, which keeps the package easier to reason about and makes the domain docs useful instead of repetitive.

## Dependency Shape

```
dag/      -> no internal deps
plan/     -> dag/
ingress/  -> plan/, storage/
storage/  -> no orchestration deps
```

`src/index.ts` re-exports the public surface for consumers. Use the package barrel instead of importing deep files from application code.

WHY: the barrel is the stable contract, while the domain folders keep the implementation split by responsibility.

## Public Surface

The package currently exposes:

- Plan generation and plan tooling from `src/plan/`
- DAG helpers from `src/dag/`
- Ingress orchestration from `src/ingress/`
- Task storage adapters from `src/storage/`

If a symbol is not re-exported from `src/index.ts`, treat it as private to the domain folder.

## Extension Points

- Add a new plan gate in `src/plan/` when validation logic needs to stay close to planning.
- Add a new storage backend in `src/storage/` by implementing the task store contract and wiring it through the adapter.
- Extend ingress handling in `src/ingress/` when inbound surfaces or mode dispatch rules change.

WHY: extension points live next to the owning domain so changes stay local and don't leak across the package.

## What This Package Is Not

- It is not the LLM provider layer. Use `@openomni/llm` for model access.
- It is not the session package. Use `@openomni/session` for session CRUD and event logs.
- It is not the pure agent runtime. Use `@openomni/agent` when you only need the ChatAgent core.
- It is not an older orchestration shim. The package is organized around the current domain folders only.

## Domain Docs

Each domain folder has its own AGENTS file with the implementation details for that area:

- `src/plan/AGENTS.md` for plan generation, gates, and plan tools
- `src/dag/AGENTS.md` for dependency-graph helpers
- `src/ingress/AGENTS.md` for inbound event handling and mode dispatch
- `src/storage/AGENTS.md` for task persistence and file-backed storage

## Style Rules

See `.sisyphus/rules/modular-code-enforcement.md`.

Keep package-level notes short, link to the owning domain doc, and avoid repeating the same API details in multiple places.

WHY: the domain docs are the source of truth, and the package doc should stay a map, not a second manual.

## Maintenance Notes

- Update this file when a new domain folder becomes part of the package surface.
- Keep the module map aligned with `src/index.ts` exports and the domain AGENTS files.
- Prefer links to the domain docs over adding implementation detail here.
- Revisit the dependency shape when a domain starts importing a new sibling.

WHY: a package map is only useful when it tracks the current folder structure instead of drifting behind it.
