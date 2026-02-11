import type { SessionMode } from "./orchestration";

export type SupervisorDecision = "local" | "spawn" | "join" | "finish";

/**
 * Summarized history package forwarded from ConversationSupervisor.
 * Raw full transcript is never passed (D10).
 */
export interface SummarizedHistory {
  summary: string;
  constraints: string[];
}

/**
 * Approved plan package that drives task decomposition and dispatch.
 * Created by ConversationSupervisor after user approval (D11).
 */
export interface ExecutionPlan {
  planId: string;
  objective: string;
  steps: ExecutionPlanStep[];
}

export interface ExecutionPlanStep {
  stepId: string;
  description: string;
  dependsOn: string[];
}

/**
 * Configuration input for ExecutionSupervisor.
 * Receives summarized history + approved plan from ConversationSupervisor.
 */
export interface ExecutionSupervisorConfig {
  history: SummarizedHistory;
  plan: ExecutionPlan;
  /** Always `persistent` for ExecutionSupervisor (canonical policy) */
  sessionMode: SessionMode;
  sessionId: string;
  traceId: string;
}

export interface ExecutionSupervisorResult {
  success: boolean;
  summary: string;
  error?: string;
  terminalDecision: SupervisorDecision;
  stepOutcomes: StepOutcome[];
}

export interface StepOutcome {
  stepId: string;
  success: boolean;
  summary: string;
  error?: string;
}

/**
 * Orchestration decision layer for a run (D8).
 *
 * - Internal-only: created by ConversationSupervisor after plan approval (D9)
 * - Receives summarized history + approved plan, not raw transcript (D10)
 * - Session mode: `persistent`
 * - Delegates execution to RunWorker — never executes LLM/tool loops directly
 */
export namespace ExecutionSupervisor {
  /**
   * Decision loop: plan -> select -> delegate -> re-evaluate.
   */
  export async function run(
    config: ExecutionSupervisorConfig,
  ): Promise<ExecutionSupervisorResult> {
    const stepOutcomes: StepOutcome[] = [];

    while (true) {
      const decision = await plan(config, stepOutcomes);

      if (decision === "finish") {
        break;
      }

      const selectedSteps = select(config.plan, stepOutcomes, decision);

      // ┌─────────────────────────────────────────────────────────┐
      // │ WORKER INVOCATION BOUNDARY                              │
      // │ Everything below this point is RunWorker's              │
      // │ responsibility. ExecutionSupervisor MUST NOT execute    │
      // │ LLM calls or tool loops directly.                       │
      // └─────────────────────────────────────────────────────────┘
      const outcomes = await delegate(decision, selectedSteps, config);
      stepOutcomes.push(...outcomes);
    }

    const allSucceeded = stepOutcomes.every((o) => o.success);

    return {
      success: allSucceeded,
      summary:
        stepOutcomes.map((o) => o.summary).join("\n") || "No work executed.",
      error: allSucceeded
        ? undefined
        : stepOutcomes
            .filter((o) => !o.success)
            .map((o) => o.error)
            .join("; "),
      terminalDecision: "finish",
      stepOutcomes,
    };
  }

  async function plan(
    config: ExecutionSupervisorConfig,
    completedOutcomes: StepOutcome[],
  ): Promise<SupervisorDecision> {
    const completedIds = new Set(completedOutcomes.map((o) => o.stepId));

    if (completedIds.size >= config.plan.steps.length) {
      return "finish";
    }

    return "local";
  }

  function select(
    executionPlan: ExecutionPlan,
    completedOutcomes: StepOutcome[],
    _decision: SupervisorDecision,
  ): ExecutionPlanStep[] {
    const completedIds = new Set(completedOutcomes.map((o) => o.stepId));

    return executionPlan.steps.filter(
      (step) =>
        !completedIds.has(step.stepId) &&
        step.dependsOn.every((dep) => completedIds.has(dep)),
    );
  }

  /**
   * Worker invocation boundary — delegates to the appropriate worker.
   *
   * - `local`: Delegate to RunWorker
   * - `spawn`: Delegate to SubagentWorker(s) via RunWorker
   * - `join`: Collect results from spawned workers
   */
  async function delegate(
    decision: SupervisorDecision,
    steps: ExecutionPlanStep[],
    _config: ExecutionSupervisorConfig,
  ): Promise<StepOutcome[]> {
    switch (decision) {
      case "local":
        // Delegate to RunWorker here
        return steps.map((step) => ({
          stepId: step.stepId,
          success: true,
          summary: `[skeleton] Step "${step.description}" delegated to RunWorker`,
        }));

      case "spawn":
        // Delegate to SubagentWorker(s) via RunWorker here
        return steps.map((step) => ({
          stepId: step.stepId,
          success: true,
          summary: `[skeleton] Step "${step.description}" spawned to SubagentWorker`,
        }));

      case "join":
        // Delegate to DispatchCoordinator here
        return steps.map((step) => ({
          stepId: step.stepId,
          success: true,
          summary: `[skeleton] Joined results for step "${step.description}"`,
        }));

      case "finish":
        return [];
    }
  }
}
