# TEAM MODE

| API | Signature |
| --- | --- |
| `TeamOrchestrator.execute` | `execute(plan: Plan, config: OrchestratorConfig): Promise<TeamResult>` |
| `Teammate.execute` | `execute(input: ExecuteInput, config: TeammateConfig): Promise<ExecuteResult>` |
| `ReviewLoop.review` | `review(input: ReviewInput, config: ReviewConfig): Promise<ReviewOutput>` |
| `StallDetector.check` | `check(ledger: RunLedgerInstance, dag: DAGStructure, config: StallConfig, noProgressTurns: number): StallResult` |
| `RunLedger.create` | `create(steps: PlanStep[]): RunLedgerInstance` |
| `DAG.build` | `build(steps: PlanStep[]): DAGStructure` |

### Architecture

`TeamOrchestrator.execute(plan, config)` is a **deterministic dispatch loop** — the Lead is NOT LLM-based. LLM is used ONLY in `ReviewLoop` for accept/reject decisions.

```
Plan
  └─→ TeamOrchestrator.execute()
        ├─→ DAG.build() + DAG.validateAcyclic()
        ├─→ RunLedger.create()
        └─→ dispatch loop:
              ├─→ DAG.getReady() → ready steps
              ├─→ Teammate.execute() → step output
              ├─→ ReviewLoop.review() → accept | reject
              │     ├─→ accept: ledger.transition("succeeded"), DAG.complete()
              │     └─→ reject: retry or fail, skipDependents()
              ├─→ StallDetector.check() → stall detection
              └─→ Bus.publish() → fire-and-forget events
```

### TeamOrchestrator API

```typescript
namespace TeamOrchestrator {
  interface OrchestratorConfig {
    reviewModel: { provider: string; id: string };
    reviewSystemPrompt?: string;
    teammates: Map<string, Teammate.TeammateConfig>; // keyed by agentId
    defaultTeammateConfig: Teammate.TeammateConfig;
    stallConfig?: StallDetector.StallConfig;
    maxAttemptsPerStep?: number; // default: 3
  }

  interface TeamResult {
    status: "completed" | "stalled" | "failed";
    completedSteps: string[];
    failedSteps: string[];
    skippedSteps: string[];
    stallReason?: Team.StallReason;
    results: Map<string, string>; // stepId → output text
  }

  async function execute(
    plan: Plan,
    config: OrchestratorConfig,
  ): Promise<TeamResult>;
}
```

**Usage example:**

```typescript
import { PlanAgent, TeamOrchestrator } from "@openomni/openomni";

// 1. Generate plan
const { plan } = await PlanAgent.generate("Build a REST API", {
  model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
});

// 2. Execute plan
const result = await TeamOrchestrator.execute(plan, {
  reviewModel: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
  teammates: new Map(),
  defaultTeammateConfig: {
    agentId: "default",
    model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
  },
});

console.log(result.status); // "completed" | "stalled" | "failed"
console.log(result.completedSteps); // string[]
console.log(result.results); // Map<stepId, output>
```

### Teammate API

```typescript
namespace Teammate {
  interface TeammateConfig {
    agentId: string;
    model: { provider: string; id: string };
    systemPrompt?: string;
    tools?: Tool.Spec[];
    budget?: ChatAgentConfig["budget"];
    toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
  }

  interface ExecuteInput {
    step: PlanStep;
    context?: string; // Output from dependency steps
    handoffDocument?: string; // Handoff from previous failed attempt
  }

  interface ExecuteResult {
    agentId: string;
    stepId: string;
    output: string;
    usage: TokenUsage;
    finishReason: string;
  }

  async function execute(
    input: ExecuteInput,
    config: TeammateConfig,
  ): Promise<ExecuteResult>;
}
```

**Key constraint**: Each `execute()` call creates a **fresh ChatAgent instance** — no cross-step state.

### ReviewLoop API

```typescript
namespace ReviewLoop {
  interface ReviewConfig {
    model: { provider: string; id: string };
    systemPrompt?: string;
    budget?: AgentBudget;
  }

  interface ReviewInput {
    step: PlanStep;
    result: string;
    agentId: string;
    attemptNumber: number;
  }

  interface ReviewOutput {
    decision: "accept" | "reject";
    feedback?: string;
    handoffDocument?: string;
  }

  async function review(
    input: ReviewInput,
    config: ReviewConfig,
  ): Promise<ReviewOutput>;
  function shouldHandoff(attemptNumber: number, maxAttempts: number): boolean;
  async function generateHandoff(
    input: ReviewInput,
    rejectionFeedback: string,
    config: ReviewConfig,
  ): Promise<string>;
}
```

**Key constraint**: ReviewLoop is the **only place LLM is used for review decisions** in Team Mode. `Teammate.execute()` also uses LLM via ChatAgent for step execution. The orchestrator dispatch loop itself is deterministic.

### StallDetector API

```typescript
namespace StallDetector {
  interface StallConfig {
    maxConsecutiveRejections: number; // default: 3
    maxNoProgressTurns: number; // default: 5
  }

  interface StallResult {
    stalled: boolean;
    reason?: Team.StallReason; // "consecutive_rejections" | "no_progress" | "unsatisfiable_deps"
    details?: string;
    stalledStepId?: string;
  }

  function check(
    ledger: RunLedgerInstance,
    dag: DAGStructure,
    config: StallConfig,
    noProgressTurns: number,
  ): StallResult;
  function checkConsecutiveRejections(
    ledger: RunLedgerInstance,
    config: StallConfig,
  ): StallResult;
  function checkNoProgress(
    ledger: RunLedgerInstance,
    dag: DAGStructure,
    config: StallConfig,
    noProgressTurns: number,
  ): StallResult;
  function checkUnsatisfiableDeps(
    ledger: RunLedgerInstance,
    dag: DAGStructure,
  ): StallResult;
}
```

**Priority order**: `consecutive_rejections` > `unsatisfiable_deps` > `no_progress`.

### RunLedger API

```typescript
// Factory function — returns RunLedgerInstance
namespace RunLedger {
  function create(steps: PlanStep[]): RunLedgerInstance;
}

interface RunLedgerInstance {
  transition(stepId: string, state: Team.StepState): void;
  recordAttempt(stepId: string): void;
  recordRejection(stepId: string): void;
  resetRejectionStreak(stepId: string): void;
  getState(): Map<string, RunLedgerEntry>;
  getStepState(stepId: string): RunLedgerEntry | undefined;
  getRunning(): RunLedgerEntry[];
  getCompleted(): RunLedgerEntry[];
}
```

**Valid transitions**: `ready → running → succeeded | failed`. `skipped` is a special case (any state → skipped).

---

## DAG UTILITIES

Pure functions for DAG build, validation, and scheduling. No mutation of inputs.

```typescript
namespace DAG {
  function build(steps: PlanStep[]): DAGStructure;
  function validateAcyclic(
    dag: DAGStructure,
  ): { valid: true } | { valid: false; cycle: string[] };
  function getReady(dag: DAGStructure, completed: Set<string>): string[];
  function complete(
    dag: DAGStructure,
    stepId: string,
    completed: Set<string>,
  ): { newlyReady: string[] };
}

interface DAGStructure {
  nodes: Set<string>;
  edges: Map<string, Set<string>>; // stepId → deps
  reverseEdges: Map<string, Set<string>>; // stepId → dependents
  pendingDeps: Map<string, number>; // stepId → initial dep count
}
```

**Algorithm**: Kahn's algorithm for cycle detection. `getReady()` derives readiness from `completed` set (pure, no mutation).

---

## TEAM EVENTS (fire-and-forget)

`TeamOrchestrator` publishes 9 `Bus` events during execution. All are **fire-and-forget** (`void Bus.publish(...)`) — errors do NOT propagate to the orchestrator.

| Event                | When published                               | Payload                                                     |
| -------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| `plan.created`       | After DAG validation, before loop            | `planId, goal, stepCount`                                   |
| `step.assigned`      | When step assigned to teammate               | `planId, stepId, agentId`                                   |
| `step.started`       | Before `Teammate.execute()`                  | `planId, stepId, agentId, attempt`                          |
| `review.decision`    | After `ReviewLoop.review()`                  | `planId, stepId, decision, feedback?`                       |
| `step.completed`     | When review accepts                          | `planId, stepId, result`                                    |
| `step.failed`        | Max attempts reached or execution throws     | `planId, stepId, error`                                     |
| `step.handoff`       | When `ReviewLoop.shouldHandoff()` is true    | `planId, stepId, from, to, handoffDocument`                 |
| `stall.detected`     | When `StallDetector.check()` returns stalled | `planId, reason, details`                                   |
| `execution.complete` | At end of `execute()`                        | `planId, status, completedSteps, failedSteps, skippedSteps` |
