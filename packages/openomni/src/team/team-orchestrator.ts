import type { Plan, PlanStep } from "@openomni/protocol";
import { Team } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { DAG } from "../dag/index";
import { RunLedger } from "./run-ledger";
import { StallDetector } from "./stall-detector";
import { ReviewLoop } from "./review-loop";
import { Teammate } from "./teammate";
import { ApprovalGate } from "./approval-gate";

const DEFAULT_STALL_CONFIG: StallDetector.StallConfig = {
  maxConsecutiveRejections: 3,
  maxNoProgressTurns: 5,
};

/** Publish a bus event, swallowing any synchronous errors. */
function safePublish<T>(...args: Parameters<typeof Bus.publish<T>>): void {
  try {
    Bus.publish(...args);
  } catch {
    // fire-and-forget: event errors must never crash the orchestrator
  }
}
export namespace TeamOrchestrator {
  export interface OrchestratorConfig {
    reviewModel: { provider: string; id: string };
    reviewSystemPrompt?: string;
    teammates: Map<string, Teammate.TeammateConfig>;
    defaultTeammateConfig: Teammate.TeammateConfig;
    stallConfig?: StallDetector.StallConfig;
    maxAttemptsPerStep?: number;
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

  export async function execute(
    plan: Plan,
    config: OrchestratorConfig,
  ): Promise<TeamResult> {
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
      const cycleText =
        acyclic.cycle.length > 0 ? `: ${acyclic.cycle.join(" -> ")}` : "";
      throw new Error(`Plan contains cycle${cycleText}`);
    }

    // Publish plan.created event (fire-and-forget)
    safePublish(Team.Events.PlanCreated, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      payload: {
        planId: plan.planId,
        goal: plan.goal,
        stepCount: plan.steps.length,
      },
    });

    const ledger = RunLedger.create(plan.steps);
    const completed = new Set<string>();
    const failed = new Set<string>();
    const skipped = new Set<string>();
    const results = new Map<string, string>();
    const pendingRetry = new Map<string, { handoffDocument?: string }>();
    const stepById = new Map(plan.steps.map((step) => [step.stepId, step]));

    const maxAttemptsPerStep = config.maxAttemptsPerStep ?? 3;
    const stallConfig = config.stallConfig ?? DEFAULT_STALL_CONFIG;
    let noProgressTurns = 0;

    while (true) {
      let progressed = false;

      const readyFromDag = DAG.getReady(dag, completed);
      const readySteps = readyFromDag.filter((stepId) => {
        if (failed.has(stepId) || skipped.has(stepId)) {
          return false;
        }

        const state = ledger.getStepState(stepId)?.state;
        return state === "ready" || pendingRetry.has(stepId);
      });

      for (const stepId of readySteps) {
        if (failed.has(stepId) || skipped.has(stepId)) {
          continue;
        }

        const step = stepById.get(stepId);
        const current = ledger.getStepState(stepId);
        if (!step || !current) {
          continue;
        }

        const retryMeta = pendingRetry.get(stepId);
        pendingRetry.delete(stepId);

        if (current.state === "ready") {
          ledger.transition(stepId, "running");
        }

        if (step.requiresApproval && config.approvalGate) {
          const approvalResult = await config.approvalGate.requestApproval({
            stepId: step.stepId,
            stepTitle: step.description,
            stepDescription: step.expectedOutput,
            plan,
          });

          if (approvalResult === "rejected") {
            ledger.transition(stepId, "failed");
            failed.add(stepId);

            safePublish(Team.Events.StepFailed, {
              traceId: crypto.randomUUID(),
              time: Date.now(),
              payload: {
                planId: plan.planId,
                stepId,
                error: "approval_rejected",
              },
            });
            skipDependents(
              stepId,
              dag,
              ledger,
              failed,
              skipped,
              completed,
              pendingRetry,
            );
            progressed = true;
            continue;
          }
        }

        ledger.recordAttempt(stepId);
        const attemptNumber = ledger.getStepState(stepId)?.attempts ?? 1;
        const teammateConfig = resolveTeammate(step, config);

        safePublish(Team.Events.StepAssigned, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          payload: {
            planId: plan.planId,
            stepId,
            agentId: teammateConfig.agentId,
          },
        });

        // Publish step.started event (fire-and-forget)
        safePublish(Team.Events.StepStarted, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          payload: {
            planId: plan.planId,
            stepId,
            agentId: teammateConfig.agentId,
            attempt: attemptNumber,
          },
        });

        try {
          const execution = await Teammate.execute(
            {
              step,
              context: buildContext(step, results),
              handoffDocument: retryMeta?.handoffDocument,
            },
            teammateConfig,
          );

          const review = await ReviewLoop.review(
            {
              step,
              result: execution.output,
              agentId: execution.agentId,
              attemptNumber,
            },
            {
              model: config.reviewModel,
              systemPrompt: config.reviewSystemPrompt,
            },
          );

          // Publish review.decision event (fire-and-forget)
          safePublish(Team.Events.ReviewDecision, {
            traceId: crypto.randomUUID(),
            time: Date.now(),
            payload: {
              planId: plan.planId,
              stepId,
              decision: review.decision,
              feedback: review.feedback,
            },
          });

          if (review.decision === "accept") {
            ledger.transition(stepId, "succeeded");
            ledger.resetRejectionStreak(stepId);
            completed.add(stepId);
            results.set(stepId, execution.output);
            DAG.complete(dag, stepId, completed);

            // Publish step.completed event (fire-and-forget)
            safePublish(Team.Events.StepCompleted, {
              traceId: crypto.randomUUID(),
              time: Date.now(),
              payload: {
                planId: plan.planId,
                stepId,
                result: execution.output,
              },
            });
            progressed = true;
            continue;
          }

          ledger.recordRejection(stepId);
          const attempts =
            ledger.getStepState(stepId)?.attempts ?? attemptNumber;

          if (attempts >= maxAttemptsPerStep) {
            ledger.transition(stepId, "failed");
            failed.add(stepId);
            ledger.resetRejectionStreak(stepId);

            // Publish step.failed event (fire-and-forget)
            safePublish(Team.Events.StepFailed, {
              traceId: crypto.randomUUID(),
              time: Date.now(),
              payload: {
                planId: plan.planId,
                stepId,
                error: `Max attempts (${maxAttemptsPerStep}) reached`,
              },
            });
            skipDependents(
              stepId,
              dag,
              ledger,
              failed,
              skipped,
              completed,
              pendingRetry,
            );
            progressed = true;
            continue;
          }

          let handoffDocument = retryMeta?.handoffDocument;
          if (review.feedback) {
            handoffDocument = review.feedback;
          }

          if (
            ReviewLoop.shouldHandoff(attempts, maxAttemptsPerStep) &&
            review.feedback
          ) {
            handoffDocument = await ReviewLoop.generateHandoff(
              {
                step,
                result: execution.output,
                agentId: execution.agentId,
                attemptNumber: attempts,
              },
              review.feedback,
              {
                model: config.reviewModel,
                systemPrompt: config.reviewSystemPrompt,
              },
            );

            // Publish step.handoff event (fire-and-forget)
            safePublish(Team.Events.StepHandoff, {
              traceId: crypto.randomUUID(),
              time: Date.now(),
              payload: {
                planId: plan.planId,
                stepId,
                from: execution.agentId,
                to: execution.agentId,
                handoffDocument,
              },
            });
          }

          pendingRetry.set(stepId, { handoffDocument });
        } catch {
          ledger.transition(stepId, "failed");
          failed.add(stepId);

          // Publish step.failed event (fire-and-forget)
          safePublish(Team.Events.StepFailed, {
            traceId: crypto.randomUUID(),
            time: Date.now(),
            payload: {
              planId: plan.planId,
              stepId,
              error: "Execution error",
            },
          });
          skipDependents(
            stepId,
            dag,
            ledger,
            failed,
            skipped,
            completed,
            pendingRetry,
          );
          progressed = true;
        }
      }

      const stall = StallDetector.check(
        ledger,
        dag,
        stallConfig,
        noProgressTurns,
      );
      if (stall.stalled && stall.reason) {
        // Publish stall.detected event (fire-and-forget)
        safePublish(Team.Events.StallDetected, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          payload: {
            planId: plan.planId,
            reason: stall.reason,
            details: `Stall detected: ${stall.reason}`,
          },
        });

        return buildResult(
          plan.steps,
          ledger,
          results,
          "stalled",
          stall.reason,
        );
      }

      if (isExecutionFinished(plan.steps, ledger)) {
        break;
      }

      if (progressed) {
        noProgressTurns = 0;
      } else {
        noProgressTurns += 1;
      }
    }

    const final = buildResult(plan.steps, ledger, results);

    // Publish execution.complete event (fire-and-forget)
    safePublish(Team.Events.ExecutionComplete, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      payload: {
        planId: plan.planId,
        status: final.status,
        completedSteps: final.completedSteps.length,
        failedSteps: final.failedSteps.length,
        skippedSteps: final.skippedSteps.length,
      },
    });

    if (final.failedSteps.length > 0) {
      return { ...final, status: "failed" };
    }

    return final;
  }
}

function resolveTeammate(
  step: PlanStep,
  config: TeamOrchestrator.OrchestratorConfig,
): Teammate.TeammateConfig {
  if (step.suggestedAgent && config.teammates.has(step.suggestedAgent)) {
    return (
      config.teammates.get(step.suggestedAgent) ?? config.defaultTeammateConfig
    );
  }

  return config.defaultTeammateConfig;
}

function buildContext(
  step: PlanStep,
  results: Map<string, string>,
): string | undefined {
  if (step.dependsOn.length === 0) {
    return undefined;
  }

  const contextBlocks: string[] = [];
  for (const dependencyId of step.dependsOn) {
    const text = results.get(dependencyId);
    if (!text) {
      continue;
    }

    contextBlocks.push(`[${dependencyId}]\n${text}`);
  }

  if (contextBlocks.length === 0) {
    return undefined;
  }

  return contextBlocks.join("\n\n");
}

function skipDependents(
  failedStepId: string,
  dag: ReturnType<typeof DAG.build>,
  ledger: ReturnType<typeof RunLedger.create>,
  failed: Set<string>,
  skipped: Set<string>,
  completed: Set<string>,
  pendingRetry: Map<string, { handoffDocument?: string }>,
): void {
  const queue = [...(dag.reverseEdges.get(failedStepId) ?? new Set<string>())];

  while (queue.length > 0) {
    const stepId = queue.shift();
    if (!stepId) {
      continue;
    }

    if (failed.has(stepId) || skipped.has(stepId) || completed.has(stepId)) {
      continue;
    }

    const state = ledger.getStepState(stepId);
    if (!state || state.state === "succeeded") {
      continue;
    }

    ledger.transition(stepId, "skipped");
    skipped.add(stepId);
    pendingRetry.delete(stepId);

    const descendants = dag.reverseEdges.get(stepId);
    if (descendants) {
      queue.push(...descendants);
    }
  }
}

function isExecutionFinished(
  steps: PlanStep[],
  ledger: ReturnType<typeof RunLedger.create>,
): boolean {
  return ledger.getCompleted().length === steps.length;
}

function buildResult(
  steps: PlanStep[],
  ledger: ReturnType<typeof RunLedger.create>,
  results: Map<string, string>,
  status: TeamOrchestrator.TeamResult["status"] = "completed",
  stallReason?: Team.StallReason,
): TeamOrchestrator.TeamResult {
  const completedSteps: string[] = [];
  const failedSteps: string[] = [];
  const skippedSteps: string[] = [];

  for (const step of steps) {
    const state = ledger.getStepState(step.stepId)?.state;
    if (state === "succeeded") {
      completedSteps.push(step.stepId);
    } else if (state === "failed") {
      failedSteps.push(step.stepId);
    } else if (state === "skipped") {
      skippedSteps.push(step.stepId);
    }
  }

  return {
    status,
    completedSteps,
    failedSteps,
    skippedSteps,
    stallReason,
    results,
  };
}
