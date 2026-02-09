import { randomUUID } from "crypto";
import { TaskManager } from "../task/manager";
import { Orchestrator } from "../loop/orchestration";
import type { RunRequest, RunResult } from "./interfaces";

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
        const task = TaskManager.create({
          title: `Ingress run: ${request.envelope.name}`,
          owner: {
            type: request.envelope.userId ? "user" : "agent",
            id: request.envelope.userId ?? "system",
          },
          triggers: [{ id: randomUUID(), type: "manual" }],
        });

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

        if (!this.config.llm) {
          return {
            success: true,
            summary: `Run scheduled: ${triggerResult.runId}`,
            runId: triggerResult.runId,
            sessionId,
            request,
          };
        }

        const orchResult = await Orchestrator.run(
          {
            taskId: task.id,
            runId: triggerResult.runId,
            maxRetries: request.agentConfig?.maxRetries ?? 1,
            sessionMode: request.agentConfig?.sessionMode ?? "persistent",
            sessionId,
          },
          {
            llm: this.config.llm,
            input: {
              prompt:
                typeof request.envelope.payload === "string"
                  ? request.envelope.payload
                  : JSON.stringify(request.envelope.payload),
            },
          },
        );

        return {
          success: orchResult.success,
          summary: orchResult.summary,
          error: orchResult.error || undefined,
          runId: triggerResult.runId,
          sessionId,
          request,
        };
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
