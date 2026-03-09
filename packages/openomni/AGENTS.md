# packages/openomni

Orchestration package. Contains legacy agent code (Phase 1 migration) plus the new Plan Mode and Team Mode architecture.

For detailed API docs, see: `docs/plan-mode.md`, `docs/team-mode.md`, `docs/ingress-engine.md`

## STRUCTURE

```
src/
├── index.ts          # Public API — re-exports all modules
├── dag/              # DAG utilities (pure functions)
│   └── index.ts      # DAG.build, DAG.validateAcyclic, DAG.getReady, DAG.complete
├── plan/             # Plan Mode — LLM-based plan generation
│   └── plan-agent.ts # PlanAgent.generate(goal, config) → PlanResult
├── team/             # Team Mode — deterministic step dispatch
│   ├── index.ts      # Team module barrel
│   ├── team-orchestrator.ts  # TeamOrchestrator.execute(plan, config) → TeamResult
│   ├── teammate.ts   # Teammate.execute(input, config) → ExecuteResult
│   ├── review-loop.ts        # ReviewLoop.review() — LLM accept/reject
│   ├── stall-detector.ts     # StallDetector.check() — stall detection
│   └── run-ledger.ts         # RunLedger.create() — in-memory step state
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

**Phase 1 (complete)**: Code moved as-is from `packages/agent`. No refactoring.
**Phase 2 (complete)**: Plan Mode (`src/plan/`) and Team Mode (`src/team/`) implemented.

## KEY EXPORTS

- **RunWorker** — LLM/tool loop execution primitive
- **TaskManager** — Task lifecycle management
- **IngressEngine** — 7-step event ingestion pipeline
- **PlanAgent** — LLM-based plan generation (does NOT execute)
- **TeamOrchestrator** — Deterministic step dispatch loop
- **DAG** — Pure DAG utilities (build, validate, schedule)

## KEY PATTERNS

- **Deterministic Lead**: `TeamOrchestrator` dispatch loop is pure logic — no LLM calls. Only `ReviewLoop` uses LLM.
- **Fire-and-forget events**: Bus events are observability hooks, not control flow. Errors in publishing don't affect execution.
- **Fresh agent per step**: `Teammate.execute()` creates a new `ChatAgent` instance per call — no cross-step session state.

## ANTI-PATTERNS

- Do NOT import from `src/legacy/` directly — use the package barrel (`@openomni/openomni`).
- No persistence: `RunLedger` is in-memory only. No checkpointing or recovery in V1.
- No dynamic step insertion: Plan is fixed at `execute()` call time. No mid-execution replanning.

## ARCHITECTURAL DECISIONS

- LLM is used ONLY in `ReviewLoop` for Team Mode accept/reject decisions.
- Plan Mode and Team Mode are V1 implementations — sequential, in-memory, no persistence.
- Legacy code in `src/legacy/` was moved as-is from `packages/agent`.

## NOTES

- This package depends on `@openomni/agent` for ChatAgent (the pure ReAct primitive).
- For the pure ChatAgent primitive (stateless, no session), use `@openomni/agent` instead.
