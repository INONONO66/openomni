# PLAN MODE

| API | Signature |
| --- | --- |
| `PlanAgent.generate` | `generate(goal: string, config: GenerateConfig): Promise<PlanResult>` |

### Architecture

`PlanAgent.generate(goal, config)` calls an LLM to produce a structured `Plan` with steps and DAG dependencies. It does **not** execute the plan — that is Team Mode's job.

```
goal (string)
  └─→ PlanAgent.generate()
        └─→ ChatAgent (LLM call)
              └─→ JSON parse + Zod validate
                    └─→ PlanResult { plan }
```

### PlanAgent API

```typescript
namespace PlanAgent {
  interface GenerateConfig {
    model: { provider: string; id: string };
    systemPrompt?: string; // Override default planning prompt
    reviewPrompt?: string; // Appended to system prompt
    budget?: AgentBudget;
  }

  async function generate(
    goal: string,
    config: GenerateConfig,
  ): Promise<PlanResult>;
}
```

**Usage example:**

```typescript
import { PlanAgent } from "@openomni/openomni";
// NOTE: PlanAgent is not yet exported from the package barrel (src/index.ts).
// Direct import: import { PlanAgent } from "@openomni/openomni/src/plan/plan-agent"

const result = await PlanAgent.generate(
  "Build a REST API for user management",
  {
    model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
  },
);

console.log(result.plan.steps); // PlanStep[]
```

### Plan Schema (from `@openomni/protocol`)

```typescript
type PlanStep = {
  stepId: string;
  description: string;
  expectedOutput: string;
  dependsOn: string[]; // stepIds this step depends on
  suggestedAgent?: string; // hint for TeamOrchestrator teammate routing
  guardrail?: string; // acceptance criteria for ReviewLoop
  tools?: Tool.Spec[];
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
