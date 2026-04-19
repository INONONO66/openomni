# Plan Domain

Tool-based plan generation: goal → LLM uses plan tools → plan stored in `Storage.PlanSubAdapter`.

## Modules

| File | Role |
|------|------|
| `run-plan.ts` | `runPlan()` — shared entry point. Creates `PlanAgent`, runs it, verifies plan was written |
| `plan-agent.ts` | `PlanAgent.create()` — builds ChatAgent with plan tools + caller-provided tools |
| `plan-tools.ts` | `PLAN_TOOL_SPECS` + `createPlanToolExecutor(adapter)` — plan_read/write/edit/list backed by `Storage.PlanSubAdapter` |
| `memory-plan-adapter.ts` | In-memory `Storage.PlanSubAdapter` for testing and fallback |
| `hashline.ts` | Hash-anchored line references for precise plan editing (used by plan_edit) |

## Composition

```
runPlan(goal, config)
  └─ PlanAgent.create(config)     → interactive agent with plan tools
  └─ agent.run(goal)              → LLM generates plan via plan_write
  └─ planSubAdapter.write()       → persists Plan to Storage.PlanSubAdapter
  └─ returns { planId }           → Plan.Result with ID reference
```

## Schema

Plan types (`Plan`, `PlanStep`, `PlanResult`) live in `@openomni/protocol/plan`.
Gate types (`Gate.Check`, `Gate.Verdict`, `Gate.Enricher`) live in `@openomni/protocol`.
