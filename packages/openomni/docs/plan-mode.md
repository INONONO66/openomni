# PLAN MODE

| API | Signature |
| --- | --- |
| `runPlan` | `runPlan(goal: string, config: RunPlanConfig): Promise<Plan.Result>` |
| `PlanAgent.create` | `create(config: CreateConfig): ChatAgentInstance` — plan agent with `plan_read` / `plan_write` / `plan_edit` / `plan_list` tools |

### Architecture

`runPlan(goal, config)` creates a `PlanAgent` with plan tools bound to `Storage.PlanSubAdapter`. The LLM writes the plan via `plan_write` tool calls. The plan is stored directly in the adapter — no JSON parsing or transformation. Result is a `{ planId }` reference.

```
goal (string)
  └─→ runPlan(goal, config)
        ├─→ PlanAgent.create(config)          (ChatAgent with plan tools)
        ├─→ agent.run(goal, sink)             (LLM uses plan_write to store plan)
        ├─→ verify plan_write was called      (via Sink.onToolCall)
        └─→ Plan.Result { planId }
```

### runPlan API

```typescript
interface RunPlanConfig {
  model: { provider: string; id: string };
  systemPrompt?: string;
  planSubAdapter?: Storage.PlanSubAdapter;  // defaults to in-memory
  planId?: string;                          // deterministic ID, defaults to randomUUID
  budget?: AgentBudget;
  tools?: Tool.Spec[];                      // additional tools (filesystem, bash)
  toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
}

function runPlan(goal: string, config: RunPlanConfig): Promise<Plan.Result>;
```

**Usage:**

```typescript
import { Storage } from "@openomni/session";
import { runPlan } from "@openomni/openomni";

const { planId } = await runPlan(
  "Build a REST API for user management",
  {
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    planSubAdapter: Storage.get().plan!,
  },
);
```

`PlanAgent.create()` returns a `ChatAgent` instance with `plan_read` / `plan_write` / `plan_edit` / `plan_list` tools bound so the LLM can create and iteratively refine a plan via hash-anchored line edits.

### Plan Result (from `@openomni/protocol`)

```typescript
// Plan.Result is a namespace type: z.infer<typeof Plan.ResultSchema>
// Equivalent to: { planId: string }
```

The plan content (markdown) is stored in `Storage.PlanSubAdapter` and can be read via `adapter.read(planId)`.

### Plan Schema (from `@openomni/protocol`)

`Plan.Schema` still exists for structured plan content validation when needed:

```typescript
type PlanStep = {
  stepId: string;
  description: string;
  expectedOutput: string;
  dependsOn: string[];
  suggestedAgent?: string;
  guardrail?: string;
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
```

### Relationship With Other Modes

- `plan` mode stores the plan in `Storage.PlanSubAdapter` and records the `planId` in the session via a `__OPENOMNI_PLANID__` marker. Subsequent `plan` calls on the same session read the previous plan from storage and combine with user feedback for iterative refinement.
- `direct` mode runs `ChatAgent` over the same session. A consumer can follow a plan step by step by calling `direct` on the same session and referencing the plan in the user message.
- Parallel execution across plan steps is the caller's responsibility (typically via `SubagentRuntime` + `BackgroundManager` dispatching one worker per ready step).

### Plan Agent (apps/server)

The server registers a `plan` agent in `apps/server/src/agents/plan-agent/` with:
- `triggers.slashCommand: "plan"` — routes `/plan` commands via existing `resolveAgentName()`
- `categories: ["filesystem", "execution"]` + `allow: ["plan_read", "plan_write", "plan_edit", "plan_list"]`
- `permissions.denylist: ["write", "edit"]` — file mutation blocked, bash allowed for exploration
