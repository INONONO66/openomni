import type { Tool } from "@openomni/protocol";
import { ChatAgent } from "../../core/chat-agent";
import { allocateBudget, checkDelegation, type DelegationContext } from "../../core/delegation";
import { AgentRegistry } from "../registry/registry";
import { AgentMessenger } from "../messenger/messenger";
import { BusTransport } from "../messenger/transport";

export interface SubagentToolOptions {
  delegationContext?: DelegationContext;
  messengerAllowPatterns?: Array<{ from: string; to: string }>;
  subagentRuntime?: {
    spawn: (config: {
      agentName: string;
      prompt: string;
      parentSessionId?: string;
      title: string;
      model: { provider: string; id: string };
      systemPrompt?: string;
    }) => Promise<{ sessionId: string; runId: string; output: string }>;
    send: (config: {
      sessionId: string;
      prompt: string;
      model: { provider: string; id: string };
      systemPrompt?: string;
    }) => Promise<{ sessionId: string; runId: string; output: string }>;
  };
}

export interface SubagentToolSpec {
  spec: Tool.Spec;
  execute: (args: unknown) => Promise<Tool.Result>;
}

export namespace SubagentTool {
  const fallbackModel = {
    provider: "anthropic",
    id: "claude-3-haiku-20240307",
  };

  export function create(options?: SubagentToolOptions): SubagentToolSpec {
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
        },
        required: ["agentName", "prompt"],
      },
    };

    const execute = async (args: unknown): Promise<Tool.Result> => {
      const { agentName, prompt, sessionId } = args as {
        agentName: string;
        prompt: string;
        sessionId?: string;
      };

      const ctx = options?.delegationContext;
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

      const definition = AgentRegistry.get(agentName);
      if (!definition) {
        return {
          id: crypto.randomUUID(),
          toolCallId: "",
          output: `Delegation failed: agent '${agentName}' is not registered`,
          isError: true,
        };
      }

      const childAbort = ctx?.parentAbort ? AbortSignal.any([ctx.parentAbort]) : undefined;
      const allocated = ctx?.parentBudgetState
        ? allocateBudget(ctx.parentBudgetState, ctx.parentBudget, ctx)
        : definition.maxTurns
          ? { maxTurns: definition.maxTurns }
          : undefined;
      const childBudget =
        allocated && definition.maxTurns
          ? {
              ...allocated,
              maxTurns: Math.min(allocated.maxTurns ?? Infinity, definition.maxTurns),
            }
          : allocated;

      const model = definition.model ?? fallbackModel;

      if (options?.subagentRuntime) {
        try {
          const result = sessionId
            ? await options.subagentRuntime.send({
                sessionId,
                prompt,
                model,
                systemPrompt: definition.systemPrompt,
              })
            : await options.subagentRuntime.spawn({
                agentName,
                prompt,
                title: prompt.slice(0, 50),
                model,
                systemPrompt: definition.systemPrompt,
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
      }

      try {
        const childAgent = ChatAgent.create({
          model,
          systemPrompt: definition.systemPrompt,
          budget: childBudget,
          permissions: definition.permissions,
          signal: childAbort,
        });

        const result = await childAgent.run({
          messages: [{ role: "user", content: prompt }],
        });

        if (ctx?.onChildBudgetConsumed && result.usage) {
          ctx.onChildBudgetConsumed(
            result.usage.inputTokens,
            result.usage.outputTokens,
            result.usage.totalCost ?? 0,
          );
        }

        const messenger = AgentMessenger.create(new BusTransport(), {
          allowPatterns: options?.messengerAllowPatterns,
        });

        await messenger.send({
          id: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
          correlationId: null,
          sessionId: "subagent-tool",
          runId: "subagent-tool",
          fromAgentId: agentName,
          toAgentId: "parent",
          sentAt: new Date().toISOString(),
          schemaRef: "completion",
          payload: result.text,
          persistencePolicy: "both",
        });

        return {
          id: crypto.randomUUID(),
          toolCallId: "",
          output: result.text,
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
