// Rule 5: approval, execution, review, retry, stall detection, and event emission share one run ledger, so the dispatch loop stays together here.
import type { Plan, PlanStep } from "@openomni/protocol";
import { Team } from "@openomni/protocol";
import { Bus, type BusEvent } from "@openomni/session";
import { DAG } from "../dag/index";
import type { ApprovalGate } from "./approval-gate";
import { ReviewLoop } from "./review-loop";
import { RunLedger } from "./run-ledger";
import { StallDetector } from "./stall-detector";
import { resolveTeamAgent } from "./team-agents";
import { resolveCategory } from "../category/category-resolver";
import { Teammate } from "./teammate";

const DEFAULT_STALL_CONFIG: StallDetector.StallConfig = {
  maxConsecutiveRejections: 3,
  maxNoProgressTurns: 5,
};

const DEFAULT_MAX_SESSION_REJECTIONS = 3;
const DEFAULT_MAX_TOTAL_ATTEMPTS = 6;

interface WorkerSessionState {
  sessionId: string;
  sessionRejections: number;
  sessionGeneration: number;
  totalAttempts: number;
}

type RetryMeta = {
  handoffDocument?: string;
  rotateSession?: boolean;
  previousSessionId?: string;
  sessionGeneration?: number;
};

interface ExecutionState {
  ledger: ReturnType<typeof RunLedger.create>;
  completed: Set<string>;
  failed: Set<string>;
  skipped: Set<string>;
  results: Map<string, string>;
  pendingRetry: Map<string, RetryMeta>;
  workerSessions: Map<string, WorkerSessionState>;
}
type TeamEventPayload<TEvent> = TEvent extends { payload: infer TPayload } ? TPayload : never;
function safePublish<T>(...args: Parameters<typeof Bus.publish<T>>): void {
  try {
    Bus.publish(...args);
  } catch {
    // fire-and-forget: event handlers are observability hooks, not control flow
  }
}
function publishTeamEvent<TEvent extends { traceId: string; time: number; payload: unknown }>(
  event: BusEvent.Descriptor<TEvent>,
  payload: TeamEventPayload<TEvent>,
): void {
  safePublish(event, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    payload,
  } as TEvent);
}

const workerEvents = Team.Events as typeof Team.Events & {
  StepAssignedToWorker: BusEvent.Descriptor<{
    traceId: string;
    time: number;
    payload: {
      stepId: string;
      workerSessionId: string;
      workerRunId: string;
      agentName: string;
    };
  }>;
  StepRejected: BusEvent.Descriptor<{
    traceId: string;
    time: number;
    payload: {
      stepId: string;
      workerSessionId: string;
      workerRunId: string;
      sessionRejections: number;
      totalAttempts: number;
      feedback?: string;
    };
  }>;
  StepHandoffRequested: BusEvent.Descriptor<{
    traceId: string;
    time: number;
    payload: {
      stepId: string;
      workerSessionId: string;
      sessionGeneration: number;
    };
  }>;
  StepHandoffCompleted: BusEvent.Descriptor<{
    traceId: string;
    time: number;
    payload: {
      stepId: string;
      newWorkerSessionId: string;
      sessionGeneration: number;
      handoffDocument?: string;
    };
  }>;
  StepSessionRotated: BusEvent.Descriptor<{
    traceId: string;
    time: number;
    payload: {
      stepId: string;
      oldSessionId: string;
      newSessionId: string;
      sessionGeneration: number;
    };
  }>;
};

export namespace TeamOrchestrator {
  export interface OrchestratorConfig {
    orchestrationSessionId?: string;
    reviewModel: { provider: string; id: string };
    reviewSystemPrompt?: string;
    teammates: Map<string, Teammate.TeammateConfig>;
    defaultTeammateConfig: Teammate.TeammateConfig;
    subagentRuntime?: Teammate.SubagentRuntime;
    stallConfig?: StallDetector.StallConfig;
    maxAttemptsPerStep?: number;
    maxSessionRejections?: number;
    maxTotalAttempts?: number;
    approvalGate?: ApprovalGate.Gate;
  }

  export interface TeamResult {
    status: "completed" | "stalled" | "failed";
    completedSteps: string[];
    failedSteps: string[];
    skippedSteps: string[];
    stallReason?: Team.StallReason;
    results: Map<string, string>;
  }

  export async function execute(plan: Plan, config: OrchestratorConfig): Promise<TeamResult> {
    if (plan.steps.length === 0) {
      return {
        status: "completed",
        completedSteps: [],
        failedSteps: [],
        skippedSteps: [],
        results: new Map<string, string>(),
      };
    }
    const dag = DAG.build(plan.steps);
    const acyclic = DAG.validateAcyclic(dag);
    if (!acyclic.valid) {
      const cycleText = acyclic.cycle.length > 0 ? `: ${acyclic.cycle.join(" -> ")}` : "";
      throw new Error(`Plan contains cycle${cycleText}`);
    }
    publishTeamEvent(Team.Events.PlanCreated, {
      planId: plan.planId,
      goal: plan.goal,
      stepCount: plan.steps.length,
    });
    const state = createExecutionState(plan.steps, config.orchestrationSessionId);
    const stepById = new Map(plan.steps.map((step) => [step.stepId, step]));
    const maxAttemptsPerStep = config.maxAttemptsPerStep ?? 3;
    const stallConfig = config.stallConfig ?? DEFAULT_STALL_CONFIG;
    let noProgressTurns = 0;
    while (true) {
      let progressed = false;
      for (const stepId of getReadySteps(dag, state)) {
        if (
          await processReadyStep(stepId, plan, stepById, dag, state, config, maxAttemptsPerStep)
        ) {
          progressed = true;
        }
      }
      const stall = StallDetector.check(state.ledger, dag, stallConfig, noProgressTurns);
      if (stall.stalled && stall.reason) {
        publishTeamEvent(Team.Events.StallDetected, {
          planId: plan.planId,
          reason: stall.reason,
          details: `Stall detected: ${stall.reason}`,
        });
        return buildResult(plan.steps, state, "stalled", stall.reason);
      }
      if (isExecutionFinished(plan.steps, state)) {
        break;
      }
      noProgressTurns = progressed ? 0 : noProgressTurns + 1;
    }
    const final = buildResult(plan.steps, state);
    publishTeamEvent(Team.Events.ExecutionComplete, {
      planId: plan.planId,
      status: final.status,
      completedSteps: final.completedSteps.length,
      failedSteps: final.failedSteps.length,
      skippedSteps: final.skippedSteps.length,
    });
    return final.failedSteps.length > 0 ? { ...final, status: "failed" } : final;
  }
}
function createExecutionState(steps: PlanStep[], orchestrationSessionId?: string): ExecutionState {
  return {
    ledger: RunLedger.create(steps, { sessionId: orchestrationSessionId }),
    completed: new Set(),
    failed: new Set(),
    skipped: new Set(),
    results: new Map(),
    pendingRetry: new Map(),
    workerSessions: new Map(),
  };
}
function getReadySteps(dag: ReturnType<typeof DAG.build>, state: ExecutionState): string[] {
  return DAG.getReady(dag, state.completed).filter((stepId) => {
    if (state.failed.has(stepId) || state.skipped.has(stepId)) return false;
    const stepState = state.ledger.getStepState(stepId)?.state;
    return stepState === "ready" || state.pendingRetry.has(stepId);
  });
}
async function processReadyStep(
  stepId: string,
  plan: Plan,
  stepById: Map<string, PlanStep>,
  dag: ReturnType<typeof DAG.build>,
  state: ExecutionState,
  config: TeamOrchestrator.OrchestratorConfig,
  maxAttemptsPerStep: number,
): Promise<boolean> {
  if (state.failed.has(stepId) || state.skipped.has(stepId)) return false;
  const step = stepById.get(stepId);
  const current = state.ledger.getStepState(stepId);
  if (!step || !current) return false;
  const retryMeta = state.pendingRetry.get(stepId);
  state.pendingRetry.delete(stepId);
  if (!(await requestApproval(plan, step, current.state, dag, state, config))) return true;
  if (current.state === "ready") state.ledger.transition(stepId, "running");
  state.ledger.recordAttempt(stepId);
  const attemptNumber = state.ledger.getStepState(stepId)?.attempts ?? 1;
  const teammateConfig = resolveTeammate(step, config);
  const workerEnabled = config.subagentRuntime !== undefined;
  const executionConfig = workerEnabled
    ? { ...teammateConfig, subagentRuntime: config.subagentRuntime }
    : teammateConfig;
  const workerSession = state.workerSessions.get(stepId);
  const shouldReuseWorkerSession =
    workerEnabled && workerSession && !retryMeta?.rotateSession
      ? workerSession.sessionId
      : undefined;
  const workerGeneration = retryMeta?.rotateSession
    ? (retryMeta.sessionGeneration ?? (workerSession?.sessionGeneration ?? 0) + 1)
    : (workerSession?.sessionGeneration ?? 0);
  const totalAttempts = workerEnabled ? (workerSession?.totalAttempts ?? 0) + 1 : attemptNumber;

  publishTeamEvent(Team.Events.StepAssigned, {
    planId: plan.planId,
    stepId,
    agentId: teammateConfig.agentId,
  });
  publishTeamEvent(Team.Events.StepStarted, {
    planId: plan.planId,
    stepId,
    agentId: teammateConfig.agentId,
    attempt: attemptNumber,
  });
  try {
    const execution = await Teammate.execute(
      {
        step,
        context: buildContext(step, state.results),
        handoffDocument: retryMeta?.handoffDocument,
        workerSessionId: shouldReuseWorkerSession,
      },
      executionConfig,
    );
    if (workerEnabled && execution.workerSessionId) {
      state.workerSessions.set(stepId, {
        sessionId: execution.workerSessionId,
        sessionRejections: retryMeta?.rotateSession ? 0 : (workerSession?.sessionRejections ?? 0),
        sessionGeneration: workerGeneration,
        totalAttempts,
      });
      publishTeamEvent(workerEvents.StepAssignedToWorker, {
        stepId,
        workerSessionId: execution.workerSessionId,
        workerRunId: execution.workerRunId ?? "",
        agentName: execution.agentId,
      });
      if (retryMeta?.rotateSession && retryMeta.previousSessionId) {
        publishTeamEvent(workerEvents.StepHandoffCompleted, {
          stepId,
          newWorkerSessionId: execution.workerSessionId,
          sessionGeneration: workerGeneration,
          handoffDocument: retryMeta.handoffDocument,
        });
        publishTeamEvent(workerEvents.StepSessionRotated, {
          stepId,
          oldSessionId: retryMeta.previousSessionId,
          newSessionId: execution.workerSessionId,
          sessionGeneration: workerGeneration,
        });
      }
    }
    const review = await ReviewLoop.review(
      { step, result: execution.output, agentId: execution.agentId, attemptNumber },
      { model: config.reviewModel, systemPrompt: config.reviewSystemPrompt },
    );
    publishTeamEvent(Team.Events.ReviewDecision, {
      planId: plan.planId,
      stepId,
      decision: review.decision,
      feedback: review.feedback,
    });
    if (review.decision === "accept") {
      completeStep(plan.planId, stepId, execution.output, dag, state);
      return true;
    }
    return handleRejectedReview(
      plan,
      step,
      execution,
      review.feedback,
      attemptNumber,
      retryMeta,
      dag,
      state,
      config,
      maxAttemptsPerStep,
      workerEnabled,
    );
  } catch (error) {
    failRunningStep(plan.planId, stepId, dag, state, describeStepFailure(error));
    return true;
  }
}
async function requestApproval(
  plan: Plan,
  step: PlanStep,
  stepState: Team.StepState,
  dag: ReturnType<typeof DAG.build>,
  state: ExecutionState,
  config: TeamOrchestrator.OrchestratorConfig,
): Promise<boolean> {
  if (stepState !== "ready" || !step.requiresApproval || !config.approvalGate) return true;
  const approvalResult = await config.approvalGate.requestApproval({
    stepId: step.stepId,
    stepTitle: step.description,
    stepDescription: step.expectedOutput,
    plan,
  });
  if (approvalResult === "approved") return true;
  state.ledger.transition(step.stepId, "skipped");
  state.failed.add(step.stepId);
  publishTeamEvent(Team.Events.StepFailed, {
    planId: plan.planId,
    stepId: step.stepId,
    error: "Step rejected by approval gate",
  });
  skipDependents(step.stepId, dag, state);
  return false;
}
function completeStep(
  planId: string,
  stepId: string,
  output: string,
  dag: ReturnType<typeof DAG.build>,
  state: ExecutionState,
): void {
  state.pendingRetry.delete(stepId);
  state.workerSessions.delete(stepId);
  state.ledger.transition(stepId, "succeeded");
  state.ledger.resetRejectionStreak(stepId);
  state.completed.add(stepId);
  state.results.set(stepId, output);
  void DAG.complete(dag, stepId, state.completed);
  // DAG.complete only previews newly-ready nodes; the next loop recomputes readiness from completed.
  publishTeamEvent(Team.Events.StepCompleted, { planId, stepId, result: output });
}
async function handleRejectedReview(
  plan: Plan,
  step: PlanStep,
  execution: {
    output: string;
    agentId: string;
    workerSessionId?: string;
    workerRunId?: string;
  },
  feedback: string | undefined,
  attemptNumber: number,
  retryMeta: RetryMeta | undefined,
  dag: ReturnType<typeof DAG.build>,
  state: ExecutionState,
  config: TeamOrchestrator.OrchestratorConfig,
  maxAttemptsPerStep: number,
  workerEnabled: boolean,
): Promise<boolean> {
  state.ledger.recordRejection(step.stepId);
  if (!workerEnabled || !execution.workerSessionId) {
    const attempts = state.ledger.getStepState(step.stepId)?.attempts ?? attemptNumber;
    if (attempts >= maxAttemptsPerStep) {
      failRunningStep(
        plan.planId,
        step.stepId,
        dag,
        state,
        `Max attempts (${maxAttemptsPerStep}) reached`,
      );
      state.ledger.resetRejectionStreak(step.stepId);
      return true;
    }

    let handoffDocument = feedback ?? retryMeta?.handoffDocument;
    if (feedback && ReviewLoop.shouldHandoff(attempts, maxAttemptsPerStep)) {
      handoffDocument = await ReviewLoop.generateHandoff(
        { step, result: execution.output, agentId: execution.agentId, attemptNumber: attempts },
        feedback,
        { model: config.reviewModel, systemPrompt: config.reviewSystemPrompt },
      );
      publishTeamEvent(Team.Events.StepHandoff, {
        planId: plan.planId,
        stepId: step.stepId,
        from: execution.agentId,
        to: execution.agentId,
        handoffDocument,
      });
    }
    state.pendingRetry.set(step.stepId, { handoffDocument });
    return false;
  }

  const workerSession = state.workerSessions.get(step.stepId) ?? {
    sessionId: execution.workerSessionId,
    sessionRejections: 0,
    sessionGeneration: 0,
    totalAttempts: attemptNumber,
  };
  const maxSessionRejections = config.maxSessionRejections ?? DEFAULT_MAX_SESSION_REJECTIONS;
  const maxTotalAttempts = config.maxTotalAttempts ?? DEFAULT_MAX_TOTAL_ATTEMPTS;
  const nextWorkerSession: WorkerSessionState = {
    ...workerSession,
    sessionRejections: workerSession.sessionRejections + 1,
    totalAttempts: workerSession.totalAttempts,
  };
  state.workerSessions.set(step.stepId, nextWorkerSession);
  publishTeamEvent(workerEvents.StepRejected, {
    stepId: step.stepId,
    workerSessionId: execution.workerSessionId,
    workerRunId: execution.workerRunId ?? "",
    sessionRejections: nextWorkerSession.sessionRejections,
    totalAttempts: nextWorkerSession.totalAttempts,
    feedback,
  });

  if (nextWorkerSession.totalAttempts >= maxTotalAttempts) {
    failRunningStep(
      plan.planId,
      step.stepId,
      dag,
      state,
      `Max total attempts (${maxTotalAttempts}) reached`,
    );
    state.ledger.resetRejectionStreak(step.stepId);
    return true;
  }

  const shouldRotateSession = nextWorkerSession.sessionRejections >= maxSessionRejections;
  const shouldGenerateHandoff =
    Boolean(feedback) &&
    (shouldRotateSession ||
      ReviewLoop.shouldHandoff(nextWorkerSession.sessionRejections, maxSessionRejections));

  let handoffDocument = feedback ?? retryMeta?.handoffDocument;
  if (feedback && shouldGenerateHandoff) {
    handoffDocument = await generateHandoffDocument(
      step,
      execution,
      feedback,
      nextWorkerSession.totalAttempts,
      config,
    );
  }

  if (!shouldRotateSession) {
    state.pendingRetry.set(step.stepId, { handoffDocument });
    return false;
  }

  publishTeamEvent(workerEvents.StepHandoffRequested, {
    stepId: step.stepId,
    workerSessionId: execution.workerSessionId,
    sessionGeneration: nextWorkerSession.sessionGeneration,
  });
  state.pendingRetry.set(step.stepId, {
    handoffDocument,
    rotateSession: true,
    previousSessionId: execution.workerSessionId,
    sessionGeneration: nextWorkerSession.sessionGeneration + 1,
  });
  return false;
}

async function generateHandoffDocument(
  step: PlanStep,
  execution: { output: string; agentId: string },
  feedback: string,
  attemptNumber: number,
  config: TeamOrchestrator.OrchestratorConfig,
): Promise<string> {
  try {
    const handoffDocument = await ReviewLoop.generateHandoff(
      { step, result: execution.output, agentId: execution.agentId, attemptNumber },
      feedback,
      { model: config.reviewModel, systemPrompt: config.reviewSystemPrompt },
    );
    if (handoffDocument.trim().length > 0) {
      return handoffDocument;
    }
  } catch {
    // handoff still needs to proceed even if the reviewer cannot synthesize one
  }

  return [
    `Step: ${step.description}`,
    `Expected Output: ${step.expectedOutput}`,
    `Last Agent: ${execution.agentId}`,
    `Attempt: ${attemptNumber}`,
    "Rejection Feedback:",
    feedback,
    "Last Result:",
    execution.output,
  ].join("\n\n");
}

function failRunningStep(
  planId: string,
  stepId: string,
  dag: ReturnType<typeof DAG.build>,
  state: ExecutionState,
  error: string,
): void {
  state.pendingRetry.delete(stepId);
  state.workerSessions.delete(stepId);
  state.ledger.transition(stepId, "failed");
  state.failed.add(stepId);
  publishTeamEvent(Team.Events.StepFailed, { planId, stepId, error });
  skipDependents(stepId, dag, state);
}
function describeStepFailure(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) return "Execution error";
  if (
    error.message.startsWith("Failed to parse review response as JSON:") ||
    error.message.startsWith("Invalid review decision:")
  ) {
    return "Review response malformed";
  }

  return error.message;
}
function resolveTeammate(
  step: PlanStep,
  config: TeamOrchestrator.OrchestratorConfig,
): Teammate.TeammateConfig {
  if (!step.suggestedAgent) return config.defaultTeammateConfig;

  const base = {
    ...config.defaultTeammateConfig,
    ...resolveTeamAgent(step.suggestedAgent),
    ...(config.teammates.get(step.suggestedAgent) ?? {}),
  };

  return applyCategoryEnrichment(base, step.suggestedAgent);
}

function applyCategoryEnrichment(
  config: Teammate.TeammateConfig,
  name: string,
): Teammate.TeammateConfig {
  const resolution = resolveCategory(name);
  if (resolution.source === "fallback") return config;

  const { promptAppend, toolHints } = resolution.config;
  if (!promptAppend && (!toolHints || toolHints.length === 0)) return config;

  const additions: string[] = [];
  if (toolHints && toolHints.length > 0) {
    additions.push(`Recommended tools: ${toolHints.join(", ")}`);
  }
  if (promptAppend) {
    additions.push(promptAppend);
  }

  const enrichedPrompt = config.systemPrompt
    ? `${config.systemPrompt}\n${additions.join("\n")}`
    : additions.join("\n");

  return { ...config, systemPrompt: enrichedPrompt };
}
function buildContext(step: PlanStep, results: Map<string, string>): string | undefined {
  if (step.dependsOn.length === 0) return undefined;
  const contextBlocks: string[] = [];
  for (const dependencyId of step.dependsOn) {
    const text = results.get(dependencyId);
    if (text) {
      contextBlocks.push(`[${dependencyId}]\n${text}`);
    }
  }
  return contextBlocks.length > 0 ? contextBlocks.join("\n\n") : undefined;
}
function skipDependents(
  failedStepId: string,
  dag: ReturnType<typeof DAG.build>,
  state: ExecutionState,
): void {
  const queue = [...(dag.reverseEdges.get(failedStepId) ?? new Set<string>())];
  while (queue.length > 0) {
    const stepId = queue.shift();
    if (
      !stepId ||
      state.failed.has(stepId) ||
      state.skipped.has(stepId) ||
      state.completed.has(stepId)
    ) {
      continue;
    }
    const stepState = state.ledger.getStepState(stepId)?.state;
    if (!stepState || stepState === "succeeded") continue;
    state.ledger.transition(stepId, "skipped");
    state.skipped.add(stepId);
    state.pendingRetry.delete(stepId);
    state.workerSessions.delete(stepId);
    const descendants = dag.reverseEdges.get(stepId);
    if (descendants) {
      queue.push(...descendants);
    }
  }
}
function isExecutionFinished(steps: PlanStep[], state: ExecutionState): boolean {
  return state.completed.size + state.failed.size + state.skipped.size === steps.length;
}
function buildResult(
  steps: PlanStep[],
  state: ExecutionState,
  status: TeamOrchestrator.TeamResult["status"] = "completed",
  stallReason?: Team.StallReason,
): TeamOrchestrator.TeamResult {
  const completedSteps: string[] = [];
  const failedSteps: string[] = [];
  const skippedSteps: string[] = [];
  for (const step of steps) {
    if (state.completed.has(step.stepId)) {
      completedSteps.push(step.stepId);
    } else if (state.failed.has(step.stepId)) {
      failedSteps.push(step.stepId);
    } else if (state.skipped.has(step.stepId)) {
      skippedSteps.push(step.stepId);
    }
  }
  return {
    status,
    completedSteps,
    failedSteps,
    skippedSteps,
    stallReason,
    results: state.results,
  };
}
