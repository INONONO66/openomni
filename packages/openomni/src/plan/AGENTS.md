# Plan Domain

LLM-driven plan generation: goal → structured `Plan` with steps, dependencies, and validation gates.

## Modules

| File | Role |
|------|------|
| `plan-agent.ts` | `PlanAgent.create()` (interactive with plan tools) and `PlanAgent.generate()` (one-shot) |
| `run-plan.ts` | `runPlan()` — shared entry point for plan execution with `Storage.PlanSubAdapter` |
| `plan-tools.ts` | Tool specs and executor for `plan_read`, `plan_write`, `plan_edit`, `plan_list` |
| `plan-store.ts` | `PlanStore` interface + `InMemoryPlanStore` implementation |
| `hashline.ts` | Hash-anchored line references for precise plan editing (load-bearing algorithm) |
| `structural-gate.ts` | Gate policy: which checks to run, thresholds, accept/reject decisions |
| `plan-checks.ts` | Pure helpers: word count, Jaccard similarity, dependency depth BFS |
| `plan-json.ts` | Pure JSON helpers: Date normalization from JSON round-trip, fence stripping |

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
