# PLAN MODE

| API | Signature |
| --- | --- |
| `PlanAgent.generate` | `generate(goal: string, config: GenerateConfig): Promise<PlanResult>` |
| `PlanAgent.create` | `create(config: GenerateConfig): ChatAgentInstance` — interactive plan agent with `plan_read` / `plan_write` / `plan_edit` tools |
| `PlanPipeline.run` | `run(goal: string, config): Promise<{ ok, plan?, issues? }>` — generate → enrich → gate loop |

### Architecture

`PlanAgent.generate(goal, config)` calls an LLM to produce a structured `Plan` with steps and DAG dependencies. It does not execute the plan. Execution is delegated to the orchestration layer (e.g. `IngressEngine` handling the `direct` follow-up, or a subagent invoked through `@openomni/openomni` `SubagentRuntime`).

```
goal (string)
  └─→ PlanAgent.generate()
        └─→ ChatAgent.run()                     (LLM call via @openomni/agent)
              └─→ JSON parse + Zod validate      (Plan schema from @openomni/protocol)
                    └─→ PlanResult { plan }

(optional)
  └─→ PlanPipeline.run(goal, { enrichers, gates, maxAttempts })
        ├─→ PlanAgent.generate()
        ├─→ enrichers[].enrich(plan)
        ├─→ gates[].check(plan) (StructuralGate uses plan-checks helpers)
        └─→ retry with feedback up to maxAttempts on gate rejection
```

### PlanAgent API

```typescript
namespace PlanAgent {
  interface GenerateConfig {
    model: { provider: string; id: string };
    systemPrompt?: string;   // override default planning prompt
    reviewPrompt?: string;   // appended to the system prompt
    budget?: AgentBudget;
  }

  function generate(goal: string, config: GenerateConfig): Promise<PlanResult>;
  function create(config: GenerateConfig): ChatAgentInstance;
}
```

**Usage:**

```typescript
import { PlanAgent } from "@openomni/openomni";

const { plan } = await PlanAgent.generate(
  "Build a REST API for user management",
  { model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" } },
);

console.log(plan.steps); // PlanStep[]
```

`PlanAgent.create()` returns a `ChatAgent` instance with `plan_read` / `plan_write` / `plan_edit` tools bound so the LLM can iteratively refine a plan via hash-anchored line edits.

### Plan Schema (from `@openomni/protocol`)

```typescript
type PlanStep = {
  stepId: string;
  description: string;
  expectedOutput: string;
  dependsOn: string[];          // stepIds this step depends on
  suggestedAgent?: string;      // optional routing hint
  guardrail?: string;           // acceptance criteria
  tools?: Tool.Spec[];
  requiresApproval?: boolean;
};

type Plan = {
  planId: string;
  goal: string;
  steps: PlanStep[];
  createdAt: Date;
  version: number;
};

type PlanResult = {
  plan: Plan;
  reviewNotes?: string;
};
```

### Relationship With Other Modes

- `plan` mode stores the generated plan as a `TextPart` with a `__OPENOMNI_PLAN__` prefix on the ingressed session. Subsequent `plan` calls on the same session combine the stored plan with user feedback for iterative refinement.
- `direct` mode runs `ChatAgent` over the same session. A consumer can follow a plan step by step by calling `direct` on the same session and referencing the plan in the user message.
- Parallel execution across plan steps is the caller's responsibility (typically via `SubagentRuntime` + `BackgroundManager` dispatching one worker per ready step).
