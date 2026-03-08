# packages/openomni

Orchestration package. Contains legacy agent code (Phase 1 migration) plus the new Plan Mode and Team Mode architecture.

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

## USAGE

```typescript
import { RunWorker, TaskManager, IngressEngine } from "@openomni/openomni";
import { PlanAgent } from "@openomni/openomni";
import { TeamOrchestrator } from "@openomni/openomni";
```

## KEY EXPORTS

### Legacy (Phase 1)

- **RunWorker** — LLM/tool loop execution primitive
- **TaskManager** — Task lifecycle management
- **IngressEngine** — 7-step event ingestion pipeline
- **ConversationSupervisor** — User-facing orchestration
- **ExecutionSupervisor** — DAG execution engine
- **BuiltinAgentRegistry** — Agent registry and lookup

### Plan Mode (Phase 2)

- **PlanAgent** — LLM-based plan generation (does NOT execute)
- **DAG** — Pure DAG utilities (build, validate, schedule)

### Team Mode (Phase 2)

- **TeamOrchestrator** — Deterministic step dispatch loop
- **Teammate** — Wraps ChatAgent for step execution
- **ReviewLoop** — LLM-based accept/reject for step results
- **StallDetector** — Detects consecutive rejections, no progress, unsatisfiable deps
- **RunLedger** — In-memory step state tracking

---

## PLAN MODE

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

---

## TEAM MODE

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

**Key constraint**: ReviewLoop is the **only place LLM is used** in Team Mode execution. The orchestrator dispatch loop itself is deterministic.

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

---

## ARCHITECTURAL DECISIONS

- **Deterministic Lead**: `TeamOrchestrator` dispatch loop is pure logic — no LLM calls. Only `ReviewLoop` uses LLM.
- **LLM only in ReviewLoop**: Keeps orchestration predictable and testable. ReviewLoop is the single LLM boundary.
- **Fire-and-forget events**: Bus events are observability hooks, not control flow. Errors in publishing don't affect execution.
- **No persistence**: `RunLedger` is in-memory only. No checkpointing or recovery in V1.
- **No concurrency**: Sequential step dispatch in V1. Steps execute one at a time even if multiple are ready.
- **No dynamic step insertion**: Plan is fixed at `execute()` call time. No mid-execution replanning.
- **No peer messaging**: Teammates don't communicate directly. Context flows via `results` map through `buildContext()`.
- **Fresh agent per step**: `Teammate.execute()` creates a new `ChatAgent` instance per call — no cross-step session state.

---

## NOTES

- This package depends on `@openomni/agent` for ChatAgent (the pure ReAct primitive).
- Legacy code in `src/legacy/` was moved as-is — it still uses `@openomni/session` internally.
- Do NOT import from `src/legacy/` directly — use the package barrel (`@openomni/openomni`).
- For the pure ChatAgent primitive (stateless, no session), use `@openomni/agent` instead.
- Plan Mode and Team Mode are V1 implementations — sequential, in-memory, no persistence.

---

## INGRESS ENGINE (Phase 3)

### Architecture

`IngressEngine.ingest(event)` is a **stateless pipeline** that validates, resolves sessions, projects events, and routes to the appropriate agent based on mode.

```
InboundEvent
  └─→ IngressEngine.ingest()
        ├─→ InboundEventSchema.parse() — Zod validation (original event preserved)
        ├─→ IngressSessionResolver.resolve() — SurfaceKey-based session lookup/create
        ├─→ IngressEventProjector.project() — UserMessage + TextPart stored in session
        └─→ switch(event.mode):
              ├─→ "plan"   → IngressHandlers.handlePlan()   → PlanAgent.generate()
              ├─→ "team"   → IngressHandlers.handleTeam()   → TeamOrchestrator.execute()
              └─→ "direct" → IngressHandlers.handleDirect() → ChatAgent.run()
```

### IngressEngine API

```typescript
namespace IngressEngine {
  // Test cleanup only — clears SurfaceKey + Session state
  function reset(): void;

  // Main entry point — fully stateless
  async function ingest(event: InboundEvent): Promise<IngressResult>;
}
```

### InboundEvent Schema (from `@openomni/protocol`)

```typescript
// Discriminated union by mode
type InboundEvent =
  | { mode: "plan";   surface: string; workspace?: string; channel?: string; payload: unknown; agent: AgentDef }
  | { mode: "team";   surface: string; workspace?: string; channel?: string; payload: unknown; agents: { reviewer: AgentDef; executor: AgentDef } }
  | { mode: "direct"; surface: string; workspace?: string; channel?: string; payload: unknown; agent: AgentDef };

type AgentDef = {
  model: { provider: string; id: string };
  systemPrompt?: string;
  tools?: Tool.Spec[];
  budget?: { maxTurns?: number };
  toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>; // TS-only, not in Zod schema
};
```

### IngressResult (from `@openomni/protocol`)

```typescript
type IngressResult =
  | { mode: "plan";   sessionId: string; result: PlanResult }
  | { mode: "team";   sessionId: string; result: TeamOrchestrator.TeamResult }
  | { mode: "direct"; sessionId: string; result: { output: string; finishReason: string } };
```

### Session Lifecycle

Single session spans the full plan→re-plan→execute lifecycle:
- Same `surface` + `workspace` + `channel` → same session (via SurfaceKey)
- Re-plan: second `mode: "plan"` call on same session includes previous Plan + user feedback in goal
- Team execution: `mode: "team"` extracts latest Plan from session, executes it

### Key Modules

| Module | File | Responsibility |
|--------|------|----------------|
| `IngressEngine` | `src/ingress/engine.ts` | Top-level stateless pipeline |
| `IngressSessionResolver` | `src/ingress/session-resolver.ts` | SurfaceKey → session lookup/create |
| `IngressEventProjector` | `src/ingress/event-projector.ts` | InboundEvent → UserMessage + TextPart |
| `SessionBridge` | `src/ingress/session-bridge.ts` | Session↔agent input/output conversion |
| `IngressHandlers` | `src/ingress/handlers.ts` | Mode-specific handler functions |

### Architectural Decisions

- **Stateless**: No `configure()` — all info comes from InboundEvent. Agent definitions provided by caller (CLI/CUI layer).
- **toolExecutor preserved**: Zod parse is validation-only; original event object used in pipeline to preserve function fields.
- **Plan stored in session**: As TextPart with `__OPENOMNI_PLAN__` prefix for extraction.
- **Re-plan via conversation**: No dedicated API — session history provides context for LLM re-generation.
- **No auto mode**: V1 requires explicit mode selection.
- **No rework**: Post-execution result modification is V2.
