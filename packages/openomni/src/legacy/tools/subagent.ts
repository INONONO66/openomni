import { z } from "zod";
import { Session } from "@openomni/session";
import type { Tool } from "@openomni/protocol";
import { BuiltinAgentRegistry, AgentMessenger, type MessageEnvelope } from "../agent";
import type { OrchestratorConfig, OrchestratorRunInput, SessionMode } from "../worker";
import { RunWorker } from "../worker";
import { TaskManager } from "../task";
import { IngressEngine } from "../ingress";

export const SubagentInput = z.object({
  agentType: z.string().describe("Agent type: 'explore', 'implement', etc."),
  prompt: z.string().describe("Instruction for the subagent"),
  sessionId: z.string().optional().describe("Resume existing session (optional)"),
});
export type SubagentInput = z.infer<typeof SubagentInput>;

const DEFAULT_MAX_SUBAGENT_DEPTH = 3;

export interface SubagentContext {
  parentDepth: number;
  maxDepth?: number;
  abortSignal?: AbortSignal;
  llm: OrchestratorRunInput["llm"];
  toolExecutor?: OrchestratorRunInput["toolExecutor"];
  parentTaskId?: string;
  parentRunId?: string;
  parentSessionId?: string;
  /** When true, this tool is executing inside a delegated worker and nested delegation is blocked. */
  insideDelegation?: boolean;
}

export interface SubagentResult {
  success: boolean;
  summary: string;
  sessionId: string;
  error?: string;
}

export namespace Subagent {
  export async function execute(
    toolCallId: string,
    rawInput: unknown,
    context: SubagentContext,
  ): Promise<Tool.Result> {
    const parseResult = SubagentInput.safeParse(rawInput);
    if (!parseResult.success) {
      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: `Invalid subagent input: ${parseResult.error.message}`,
        isError: true,
      };
    }

    const input = parseResult.data;

    if (context.insideDelegation) {
      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: "Nested delegation not allowed: subagent cannot call subagent/dispatch",
        isError: true,
      };
    }

    const maxDepth = context.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
    const childDepth = context.parentDepth + 1;

    if (childDepth >= maxDepth) {
      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: `Subagent depth limit reached: ${childDepth} >= ${maxDepth}. Cannot spawn further subagents.`,
        isError: true,
      };
    }

    if (context.abortSignal?.aborted) {
      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: "Subagent execution aborted by parent",
        isError: true,
      };
    }

    const agent = BuiltinAgentRegistry.get(input.agentType);
    if (!agent) {
      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: `Unknown agent type: "${input.agentType}". Available: ${BuiltinAgentRegistry.list()
          .map((a) => a.name)
          .join(", ")}`,
        isError: true,
      };
    }

    const sessionMode: SessionMode = input.sessionId ? "reuse" : "ephemeral";

    const childTask = TaskManager.create(
      {
        title: `Subagent: ${input.agentType}`,
        description: input.prompt,
        owner: { type: "agent", id: input.agentType },
        triggers: [{ id: "subagent-trigger", type: "manual" }],
      },
      { intent: "run_tracking" },
    );

    const spawnedBy =
      context.parentTaskId && context.parentRunId && context.parentSessionId
        ? {
            taskId: context.parentTaskId,
            runId: context.parentRunId,
            sessionId: context.parentSessionId,
          }
        : undefined;

    const triggerResult = await TaskManager.trigger(childTask.id, {
      triggerId: "subagent-trigger",
      type: "manual",
      occurredAt: Date.now(),
      spawnedBy,
    });

    if ("error" in triggerResult) {
      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: `Failed to create child run: ${triggerResult.error}`,
        isError: true,
      };
    }

    const childRunId = triggerResult.runId;

    if (sessionMode === "reuse" && input.sessionId) {
      const existing = Session.get(input.sessionId);
      if (!existing) {
        const now = Date.now();
        const session: Session.Info = {
          id: input.sessionId,
          title: `Subagent: ${input.agentType}`,
          model: {
            providerID: "agent",
            modelID: agent.name,
          },
          time: {
            created: now,
            updated: now,
          },
        };
        Session.storage.set(session.id, session);
      }
    }

    const config: OrchestratorConfig = {
      taskId: childTask.id,
      runId: childRunId,
      maxRetries: 0,
      sessionMode,
      sessionId: input.sessionId,
      maxSubagentDepth: maxDepth,
      currentDepth: childDepth,
      insideDelegation: true,
    };

    const orchestratorInput: OrchestratorRunInput = {
      llm: context.llm,
      input: {
        systemPrompt: agent.systemPrompt,
        prompt: input.prompt,
        agentType: input.agentType,
        tools: agent.tools,
        permissions: agent.permissions,
        maxTurns: agent.maxTurns,
      },
      toolExecutor: context.toolExecutor,
    };

    try {
      const result = await executeWithAbort(config, orchestratorInput, context.abortSignal);

      announceCompletion(context, input, config, result);

      if (result.success) {
        IngressEngine.ingest({
          id: crypto.randomUUID(),
          surface: "internal",
          name: "subagent.completed",
          payload: { taskId: childTask.id, summary: result.summary },
          meta: {
            originTaskId: childTask.id,
            executionContext: "task",
            resultSummary: result.summary,
          },
          occurredAt: new Date().toISOString(),
        }).catch((error) => {
          console.error(
            `[Subagent] Failed to emit completion event for task ${childTask.id}:`,
            error,
          );
        });

        return {
          id: crypto.randomUUID(),
          toolCallId,
          output: result.summary || "Subagent completed with no output.",
          isError: false,
        };
      }

      IngressEngine.ingest({
        id: crypto.randomUUID(),
        surface: "internal",
        name: "subagent.failed",
        payload: { taskId: childTask.id, error: result.error },
        meta: {
          originTaskId: childTask.id,
          executionContext: "task",
          error: result.error,
        },
        occurredAt: new Date().toISOString(),
      }).catch((error) => {
        console.error(`[Subagent] Failed to emit failure event for task ${childTask.id}:`, error);
      });

      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: `Subagent failed: ${result.error}`,
        isError: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      announceCompletion(context, input, config, {
        success: false,
        summary: "",
        error: message,
      });

      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: `Subagent execution error: ${message}`,
        isError: true,
      };
    }
  }

  function announceCompletion(
    context: SubagentContext,
    input: SubagentInput,
    childConfig: OrchestratorConfig,
    result: { success: boolean; summary: string; error?: string },
  ): void {
    if (!context.parentSessionId) return;

    const envelope: MessageEnvelope = {
      traceId: crypto.randomUUID(),
      sessionId: context.parentSessionId,
      runId: crypto.randomUUID(),
      fromAgentId: "subagent-worker",
      toAgentId: "surface-agent",
      sentAt: new Date().toISOString(),
      schemaRef: "subagent.completion.announce.v1",
      payload: {
        childSessionId: childConfig.sessionId ?? childConfig.runId,
        agentType: input.agentType,
        summary: result.summary,
        success: result.success,
        error: result.error,
      },
      persistencePolicy: "asker_only",
    };

    AgentMessenger.send(envelope).catch((err) => {
      console.error("Announce failed (non-fatal):", err);
    });
  }

  async function executeWithAbort(
    config: OrchestratorConfig,
    input: OrchestratorRunInput,
    abortSignal?: AbortSignal,
  ) {
    if (!abortSignal) {
      return RunWorker.run(config, input);
    }

    if (abortSignal.aborted) {
      return {
        success: false,
        summary: "",
        error: "Subagent execution aborted by parent",
      };
    }

    return new Promise<{
      success: boolean;
      summary: string;
      error: string;
    }>((resolve) => {
      const onAbort = () => {
        resolve({
          success: false,
          summary: "",
          error: "Subagent execution aborted by parent",
        });
      };

      abortSignal.addEventListener("abort", onAbort, { once: true });

      RunWorker.run(config, input)
        .then((result) => {
          abortSignal.removeEventListener("abort", onAbort);
          resolve(result);
        })
        .catch((err) => {
          abortSignal.removeEventListener("abort", onAbort);
          resolve({
            success: false,
            summary: "",
            error: err instanceof Error ? err.message : String(err),
          });
        });
    });
  }
}
