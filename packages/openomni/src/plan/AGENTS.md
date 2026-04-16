# Plan Domain

LLM-driven plan generation: goal → structured `Plan` with steps, dependencies, and validation gates.

## Modules

| File | Role |
|------|------|
| `plan-agent.ts` | `PlanAgent.create()` (interactive with plan tools) and `PlanAgent.generate()` (one-shot JSON) |
| `plan-pipeline.ts` | Orchestrates generate → enrich → gate with retry loop |
| `plan-tools.ts` | Tool specs and executor for `plan_read`, `plan_write`, `plan_edit` |
| `plan-store.ts` | `PlanStore` interface + `InMemoryPlanStore` implementation |
| `hashline.ts` | Hash-anchored line references for precise plan editing (load-bearing algorithm) |
| `structural-gate.ts` | Gate policy: which checks to run, thresholds, accept/reject decisions |
| `plan-checks.ts` | Pure helpers: word count, Jaccard similarity, dependency depth BFS |
| `plan-json.ts` | Pure JSON helpers: Date normalization from JSON round-trip, fence stripping |

## Composition

```
PlanPipeline.run(goal, config)
  └─ PlanAgent.generate(goal)     → raw Plan from LLM
  └─ enrichers[].enrich(plan)     → enriched Plan
  └─ gates[].check(plan)          → StructuralGate.evaluate()
       └─ plan-checks helpers     → pure algorithms
  └─ retry on gate failure        → re-generate with feedback
```

## Schema

Plan types (`Plan`, `PlanStep`, `PlanResult`) live in `@openomni/protocol/plan`.
Gate types (`Gate.Check`, `Gate.Verdict`, `Gate.Enricher`) live in `@openomni/protocol`.
