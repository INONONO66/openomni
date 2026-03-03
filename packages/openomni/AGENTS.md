# packages/openomni

Orchestration package. Contains all legacy agent code migrated from `packages/agent` in Phase 1 of the agent architecture redesign.

## STRUCTURE

```
src/
├── index.ts          # Public API — re-exports all legacy modules
└── legacy/           # All 10 domains migrated as-is from packages/agent
    ├── index.ts      # Legacy barrel — re-exports all 10 domains
    ├── agent/        # Agent identity, registry, messaging
    ├── config/       # AutonomousLoopConfig + ConfigManager
    ├── conversation/ # ConversationSupervisor
    ├── dispatch/     # Event pipeline (envelope → router → dispatcher)
    ├── execution/    # DAG execution engine (ExecutionSupervisor)
    ├── ingress/      # IngressEngine 7-step pipeline
    ├── task/         # Task lifecycle management (TaskManager)
    ├── tools/        # Dynamic Supervisor tools (subagent, dispatch, schedule)
    ├── trigger/      # External event sources (cron, fs, webhook)
    └── worker/       # Execution runtime (RunWorker, policy, telemetry)
```

## MIGRATION STATUS

**Phase 1 (current)**: Code moved as-is from `packages/agent`. No refactoring.
**Phase 2 (future)**: Add Plan/Team/Router/Memory layers. Refactor legacy code.

## USAGE

```typescript
import { RunWorker, TaskManager, IngressEngine } from "@openomni/openomni";
```

All exports from the legacy agent code are available via `@openomni/openomni`.

## KEY EXPORTS

- **RunWorker** — LLM/tool loop execution primitive
- **TaskManager** — Task lifecycle management
- **IngressEngine** — 7-step event ingestion pipeline
- **ConversationSupervisor** — User-facing orchestration
- **ExecutionSupervisor** — DAG execution engine
- **BuiltinAgentRegistry** — Agent registry and lookup

## NOTES

- This package depends on `@openomni/agent` for ChatAgent (the pure ReAct primitive).
- Legacy code in `src/legacy/` was moved as-is — it still uses `@openomni/session` internally.
- Do NOT import from `src/legacy/` directly — use the package barrel (`@openomni/openomni`).
- For the pure ChatAgent primitive (stateless, no session), use `@openomni/agent` instead.
