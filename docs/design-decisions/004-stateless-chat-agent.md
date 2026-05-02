# ADR-004: Stateless ChatAgent Separated from Orchestration

**Status**: Accepted

## Context

Originally, `packages/agent` contained both the LLM ReAct loop and all orchestration code (task management, DAG execution, triggers, ingress). This made `agent` a monolithic package with mixed responsibilities.

## Decision

Split responsibilities across two packages:

- **`packages/agent`** — Stateless `ChatAgent` primitive plus the multi-agent runtime (messenger, registry, subagent / background tool specs, MCP client). It does not own session lifecycle or durable conversation state; sinks and transports are injected by callers. It may use sanctioned session observability primitives.
- **`packages/openomni`** — Orchestration: `IngressEngine`, `PlanAgent`, `runPlan`, DAG utilities, execution-runtime tool providers, and the session-backed subagent layer (`SubagentRuntime`, `BackgroundManager`, `SubagentConsultation`). Task persistence contracts live in `@openomni/protocol` and implementations live behind `@openomni/session` storage sub-adapters.

`ChatAgent` remains a function-style primitive: take messages + tools, run the ReAct loop, return results. State (budget, memory, delegation depth) lives on a per-call context. Extension happens via the middleware engine in `packages/agent/src/core/middleware/`.

## Rationale

- **Single responsibility**: `ChatAgent` only runs an LLM tool-use loop. Orchestration is a separate concern.
- **Reusability**: `ChatAgent` can be used standalone or composed by `SubagentRuntime`, `PlanAgent`, and `IngressEngine` without pulling in orchestration dependencies.
- **Testability**: `ChatAgent` tests don't require session mocking, storage setup, or event bus wiring.
- **Dependency hygiene**: `agent` depends on execution contracts and model access, while session-backed orchestration lives in `openomni`. Any `agent` use of `session` must be limited to observability primitives, not state ownership.

## Consequences

- `SubagentRuntime` creates fresh `ChatAgent` instances per run while persisting the transcript into `@openomni/session` — `ChatAgent` itself stays stateless.
- `openomni` depends on `agent`, but `agent` knows nothing about `openomni` or about session storage.
- Extension points are standardized on the middleware engine. Legacy `hooks` / `stepGuard` config still work through `middleware/compat.ts` but are deprecated.
- `ChatAgent.stream()` is implemented as an `AsyncGenerator<AgentEvent>` via `streamAgent()`; `run()` is a thin wrapper that drains `stream()`.
