import { randomUUID } from "crypto";
import { TaskManager } from "../task";
import { ConversationSupervisor } from "../conversation";
import { ExecutionSupervisor } from "../execution";
import { classifyLane } from "./event-kinds";
import type { RunRequest, RunResult } from "./engine";

// ============================================================
// RunExecutor Interface
// ============================================================

/**
 * RunExecutor executes a RunRequest and returns a RunResult.
 * This interface enables custom execution strategies for different RunRequest kinds.
 */
export interface RunExecutor {
  /**
   * Execute a run request and return the result.
   * @param request - The run request to execute
   * @returns Promise resolving to the run result
   */
  execute(request: RunRequest): Promise<RunResult>;
}

// ============================================================
// DefaultRunExecutor
// ============================================================

/**
 * Configuration for DefaultRunExecutor.
 */
export interface DefaultRunExecutorConfig {
  /** LLM runner for run_agent execution */
  llm?: {
    run(input: Record<string, unknown>, sink: any): Promise<any>;
  };
  /** Notification adapter for notify_only execution */
  notification?: {
    name: string;
    notify(request: any): Promise<any>;
  };
}

/**
 * Default implementation of RunExecutor.
 * Handles trigger_task, run_agent, and notify_only execution kinds.
 */
export class DefaultRunExecutor implements RunExecutor {
  private config: DefaultRunExecutorConfig;

  constructor(config: DefaultRunExecutorConfig = {}) {
    this.config = config;
  }

  async execute(request: RunRequest): Promise<RunResult> {
    const sessionId = request.session.id;

    switch (request.kind) {
      case "trigger_task": {
        // D6: Block trigger_task execution in task context
        if (request.envelope.meta?.executionContext === "task") {
          return {
            success: false,
            summary: "",
            error: "[D6_task_from_task] trigger_task blocked in task context",
            sessionId,
            request,
          };
        }

        // Anti-loop: Block telemetry events from creating trigger_task
        if (classifyLane(request.envelope.name) === "telemetry") {
          return {
            success: false,
            summary: "",
            error: "[anti_loop] telemetry events cannot create trigger_task",
            sessionId,
            request,
          };
        }

        if (!request.taskId || !request.triggerSignal) {
          return {
            success: false,
            summary: "",
            error: "trigger_task requires taskId and triggerSignal",
            sessionId,
            request,
          };
        }

        const triggerResult = await TaskManager.trigger(
          request.taskId,
          request.triggerSignal,
        );

        if ("error" in triggerResult) {
          return {
            success: false,
            summary: "",
            error: `TaskManager.trigger failed: ${triggerResult.error}`,
            sessionId,
            request,
          };
        }

        return {
          success: true,
          summary: `Task ${request.taskId} triggered, runId: ${triggerResult.runId}`,
          runId: triggerResult.runId,
          sessionId,
          request,
        };
      }

      case "run_agent": {
        const taskId = randomUUID();
        const task = TaskManager.create(
          {
            title: `Ingress run: ${request.envelope.name}`,
            owner: {
              type: request.envelope.userId ? "user" : "agent",
              id: request.envelope.userId ?? "system",
            },
            triggers: [{ id: randomUUID(), type: "manual" }],
          },
          { intent: "run_tracking" },
        );

        const signal = {
          triggerId: task.triggers[0]!.id,
          type: "manual" as const,
          context: {
            conversationSessionId: sessionId,
            userId: request.envelope.userId,
            workspaceId: request.envelope.workspaceId,
            traceId: request.envelope.traceId,
          },
          occurredAt: Date.now(),
        };

        const triggerResult = await TaskManager.trigger(task.id, signal);
        if ("error" in triggerResult) {
          return {
            success: false,
            summary: "",
            error: `Failed to create run: ${triggerResult.error}`,
            sessionId,
            request,
          };
        }

        // Guard: reject direct ExecutionSupervisor bypass (D9)
        if (request.agentConfig?.agentType === "execution_direct") {
          return {
            success: false,
            summary: "",
            error:
              "External events must route through ConversationSupervisor (D9). " +
              "Direct ExecutionSupervisor entry is rejected.",
            sessionId,
            request,
          };
        }

        // External run_agent → ConversationSupervisor first (D9)
        const conversationResult = await ConversationSupervisor.run(
          {
            conversationSessionId: sessionId,
            sessionMode:
              request.agentConfig?.sessionMode === "reuse" ||
              request.agentConfig?.sessionMode === "persistent"
                ? request.agentConfig.sessionMode
                : "persistent",
            agentId: request.agentConfig?.agentType,
            traceId: request.envelope.traceId,
          },
          {
            content:
              typeof request.envelope.payload === "string"
                ? request.envelope.payload
                : JSON.stringify(request.envelope.payload),
            metadata: {
              taskId: task.id,
              runId: triggerResult.runId,
              userId: request.envelope.userId,
              workspaceId: request.envelope.workspaceId,
            },
          },
        );

        switch (conversationResult.type) {
          case "immediate":
            return {
              success: true,
              summary: conversationResult.response,
              runId: triggerResult.runId,
              sessionId,
              request,
            };

          case "plan_pending":
            return {
              success: true,
              summary: `Plan pending approval: ${conversationResult.plan.title}`,
              runId: triggerResult.runId,
              sessionId,
              request,
            };

          case "execution_forked": {
            const fork = conversationResult.fork;
            const execResult = await ExecutionSupervisor.run({
              history: {
                summary: fork.summarizedHistory.contextSummary,
                constraints: fork.summarizedHistory.constraints,
              },
              plan: {
                planId: fork.approvedPlan.planId,
                objective: fork.approvedPlan.description,
                steps: fork.approvedPlan.workItems.map((item, i) => ({
                  stepId: `step-${i}`,
                  description: item.description,
                  dependsOn: (item.dependsOn ?? []).map((d) => `step-${d}`),
                })),
              },
              sessionMode: "persistent",
              sessionId: fork.conversationSessionId,
              traceId: fork.traceId,
            });

            return {
              success: execResult.success,
              summary: execResult.summary,
              error: execResult.error,
              runId: triggerResult.runId,
              sessionId,
              request,
            };
          }

          case "ended":
            return {
              success: true,
              summary: conversationResult.reason,
              runId: triggerResult.runId,
              sessionId,
              request,
            };

          case "error":
            return {
              success: false,
              summary: "",
              error: conversationResult.error,
              runId: triggerResult.runId,
              sessionId,
              request,
            };
        }
      }

      case "notify_only": {
        if (!request.notificationRequest) {
          return {
            success: false,
            summary: "",
            error: "notify_only requires notificationRequest",
            sessionId,
            request,
          };
        }

        const notificationAdapter = this.config.notification ?? {
          name: "noop",
          async notify() {
            return { delivered: true };
          },
        };

        const result = await notificationAdapter.notify(
          request.notificationRequest,
        );

        return {
          success: result.delivered,
          summary: result.delivered
            ? `Notification delivered to ${result.destination ?? "default"}`
            : `Notification delivery failed: ${result.error ?? "unknown error"}`,
          error: result.error,
          sessionId,
          request,
        };
      }

      default:
        return {
          success: false,
          summary: "",
          error: `Unknown run request kind: ${(request as RunRequest).kind}`,
          sessionId,
          request,
        };
    }
  }
}
