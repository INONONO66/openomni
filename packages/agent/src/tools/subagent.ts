import { Session } from "@openomni/session";
import type { ToolResult } from "@openomni/protocol";
import { SubagentInput } from "./schemas";
import { BuiltinAgentRegistry } from "../agent/registry";
import type {
  OrchestratorConfig,
  OrchestratorRunInput,
  SessionMode,
} from "../loop/orchestration";
import { RunWorker } from "../loop/run-worker";
import { TaskManager } from "../task/manager";
import { IngressEngine } from "../ingress/engine";

const DEFAULT_MAX_SUBAGENT_DEPTH = 3;

export interface SubagentContext {
  parentDepth: number;
  maxDepth?: number;
  abortSignal?: AbortSignal;
  llm: OrchestratorRunInput["llm"];
  toolExecutor?: OrchestratorRunInput["toolExecutor"];
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
  ): Promise<ToolResult> {
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

    const triggerResult = await TaskManager.trigger(childTask.id, {
      triggerId: "subagent-trigger",
      type: "manual",
      occurredAt: Date.now(),
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
      const result = await executeWithAbort(
        config,
        orchestratorInput,
        context.abortSignal,
      );

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
        }).catch(() => {});

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
      }).catch(() => {});

      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: `Subagent failed: ${result.error}`,
        isError: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: `Subagent execution error: ${message}`,
        isError: true,
      };
    }
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
