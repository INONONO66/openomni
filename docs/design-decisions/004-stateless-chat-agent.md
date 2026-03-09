# ADR-004: Stateless ChatAgent Separated from Orchestration

**Status**: Accepted

## Context

Originally, `packages/agent` contained both the LLM ReAct loop and all orchestration code (task management, DAG execution, triggers, ingress). This made `agent` a monolithic package with mixed responsibilities.

## Decision

Split into two packages:

- **`packages/agent`** — Pure `ChatAgent` primitive. Stateless LLM + Tool ReAct loop. No session dependency.
- **`packages/openomni`** — All orchestration: `RunWorker`, `TaskManager`, `IngressEngine`, `PlanAgent`, `TeamOrchestrator`, legacy agent code.

`ChatAgent` is a function: takes messages + tools, runs an LLM loop, returns results. It holds no session state, manages no lifecycle, and knows nothing about multi-agent coordination.

## Rationale

- **Single responsibility**: `ChatAgent` does one thing — run an LLM tool-use loop. Orchestration is a separate concern.
- **Reusability**: `ChatAgent` can be used standalone (direct mode) or composed into larger flows (team mode) without pulling in orchestration dependencies.
- **Testability**: `ChatAgent` tests don't need session mocking, storage setup, or event bus wiring.
- **Dependency hygiene**: `agent` depends on `protocol` + `llm` only. Orchestration code that needs `session` lives in `openomni`.

## Consequences

- Fresh `ChatAgent` instance per step in `TeamOrchestrator` — no cross-step session state.
- `openomni` depends on `agent` for `ChatAgent`, but `agent` knows nothing about `openomni`.
- Legacy orchestration code moved as-is to `packages/openomni/src/legacy/` (Phase 1). Refactoring is separate from migration.
- `stream()` on `ChatAgent` is a stub (planned for future implementation).
