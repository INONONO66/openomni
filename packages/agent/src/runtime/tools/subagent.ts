import type { Tool, Subagent } from "@openomni/protocol";
import { AgentRegistry } from "../registry/registry";
import { checkDelegation, type DelegationContext } from "../../core/delegation";
import type { PolicyRegistration } from "../../core/policy/types";
import type { AgentRuntimeContext } from "../../core/runtime-context";

export interface SubagentRuntimeSpawnConfig {
  agentName: string;
  title: string;
  prompt: string;
  model: { provider: string; id: string };
  systemPrompt?: string;
  middleware?: PolicyRegistration[];
}

export interface SubagentRuntimeSendConfig {
  sessionId: string;
  prompt: string;
  model: { provider: string; id: string };
  systemPrompt?: string;
  middleware?: PolicyRegistration[];
}

export type SubagentRuntime = {
  spawn: (
    config: SubagentRuntimeSpawnConfig,
  ) => Promise<{ sessionId: string; runId: string; output: string }>;
  send: (
    config: SubagentRuntimeSendConfig,
  ) => Promise<{ sessionId: string; runId: string; output: string }>;
};

export interface SubagentToolOptions {
  context?: AgentRuntimeContext;
  delegationContext?: DelegationContext;
  messengerAllowPatterns?: Array<{ from: string; to: string }>;
  middleware?: PolicyRegistration[];
  defaultModel?: { provider: string; id: string };
  subagentRuntime: SubagentRuntime;
  backgroundManager?: {
    launch: (input: {
      agentName: string;
      prompt: string;
      model: { provider: string; id: string };
      parentSessionId: string;
      depth?: number;
    }) => Promise<Subagent.BackgroundTask>;
    getTask: (taskId: string) => Subagent.BackgroundTask | undefined;
    getResult: (taskId: string) => Subagent.BackgroundTaskResult | undefined;
    cancel: (taskId: string) => Promise<boolean> | boolean;
  };
}

export interface SubagentToolSpec {
  spec: Tool.Spec;
  execute: (args: unknown) => Promise<Tool.Result>;
}

export namespace SubagentTool {
  const DEFAULT_SUBAGENT_MODEL = {
    provider: "anthropic",
    id: "claude-3-haiku-20240307",
  };

  export function create(options: SubagentToolOptions): SubagentToolSpec {
    const spec: Tool.Spec = {
      name: "subagent",
      description:
        "Delegate a task to a registered sub-agent by name. Returns the agent's final text response.",
      inputSchema: {
        type: "object",
        properties: {
          agentName: {
            type: "string",
            description: "Name of the registered agent to delegate to",
          },
          prompt: {
            type: "string",
            description: "The task or question to send to the sub-agent",
          },
          sessionId: {
            type: "string",
            description: "Optional session ID to continue an existing subagent session",
          },
          background: {
            type: "boolean",
            description: "Run in background (returns task_id immediately)",
          },
        },
        required: ["agentName", "prompt"],
      },
    };

    const execute = async (args: unknown): Promise<Tool.Result> => {
      const { agentName, prompt, sessionId, background } = args as {
        agentName: string;
        prompt: string;
        sessionId?: string;
        background?: boolean;
      };

      const ctx = options.delegationContext;
      if (ctx) {
        const verdict = checkDelegation(agentName, ctx);
        if (verdict === "circular_detected") {
          return {
            id: crypto.randomUUID(),
            toolCallId: "",
            output: `Delegation denied: circular delegation detected for agent '${agentName}'`,
            isError: true,
          };
        }
        if (verdict === "depth_exceeded") {
          return {
            id: crypto.randomUUID(),
            toolCallId: "",
            output: `Delegation denied: max delegation depth (${ctx.maxDepth}) exceeded`,
            isError: true,
          };
        }
      }

      const definition = options.context?.registry.get(agentName) ?? AgentRegistry.get(agentName);
      if (!definition) {
        return {
          id: crypto.randomUUID(),
          toolCallId: "",
          output: `Delegation failed: agent '${agentName}' is not registered`,
          isError: true,
        };
      }

      const model = definition.model ?? options.defaultModel ?? DEFAULT_SUBAGENT_MODEL;

      if (background) {
        if (!options.backgroundManager) {
          return {
            id: crypto.randomUUID(),
            toolCallId: "",
            output: "background execution not available: no BackgroundManager configured",
            isError: true,
          };
        }
        const task = await options.backgroundManager.launch({
          agentName,
          prompt,
          model,
          parentSessionId: sessionId ?? `anon_${crypto.randomUUID().slice(0, 8)}`,
        });
        if (task.status === "failed") {
          return {
            id: crypto.randomUUID(),
            toolCallId: "",
            output: `Background task failed: ${task.error ?? "unknown error"}`,
            isError: true,
          };
        }
        return {
          id: crypto.randomUUID(),
          toolCallId: "",
          output: `Background task launched.\n\nTask ID: ${task.id}\nStatus: ${task.status}`,
          isError: false,
        };
      }

      const propagated = options.middleware?.filter((m) => m.propagate === true) ?? [];

      try {
        const result = sessionId
          ? await options.subagentRuntime.send({
              sessionId,
              prompt,
              model,
              systemPrompt: definition.systemPrompt,
              middleware: propagated.length > 0 ? propagated : undefined,
            })
          : await options.subagentRuntime.spawn({
              agentName,
              prompt,
              title: prompt.slice(0, 50),
              model,
              systemPrompt: definition.systemPrompt,
              middleware: propagated.length > 0 ? propagated : undefined,
            });

        return {
          id: crypto.randomUUID(),
          toolCallId: "",
          output: `${result.output}\n[session:${result.sessionId}]`,
          isError: false,
        };
      } catch (error) {
        return {
          id: crypto.randomUUID(),
          toolCallId: "",
          output: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    };

    return { spec, execute };
  }
}
