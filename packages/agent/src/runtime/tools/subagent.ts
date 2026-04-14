import type { Tool } from "@openomni/protocol";
import { ProviderTransform } from "@openomni/llm";
import { ChatAgent } from "../../core/chat-agent";
import { checkDelegation, type DelegationContext } from "../../core/delegation";
import { AgentRegistry } from "../registry/registry";
import { AgentMessenger } from "../messenger/messenger";
import { BusTransport } from "../messenger/transport";
import type { MiddlewareRegistration } from "../../core/middleware/types";

export interface SubagentToolOptions {
  delegationContext?: DelegationContext;
  messengerAllowPatterns?: Array<{ from: string; to: string }>;
  middleware?: MiddlewareRegistration[];
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

      const childAbort = ctx?.parentAbort;
      const childBudget = definition.budget;
      const model = definition.model ?? fallbackModel;
      const variantOptions = ProviderTransform.resolveVariant(model, definition.variant);
      const providerOptions: Record<string, unknown> = {
        ...variantOptions,
        ...(definition.temperature !== undefined && { temperature: definition.temperature }),
      };

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
        const propagated = options?.middleware?.filter((m) => m.propagate === true) ?? [];
        const childAgent = ChatAgent.create({
          model,
          systemPrompt: definition.systemPrompt,
          budget: childBudget,
          permissions: definition.permissions,
          signal: childAbort,
          providerOptions: Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
          middleware: propagated.length > 0 ? propagated : undefined,
        });

        const result = await childAgent.run({
          messages: [{ role: "user", content: prompt }],
        });

        if (ctx?.onChildTokensConsumed && result.usage) {
          ctx.onChildTokensConsumed(result.usage.inputTokens, result.usage.outputTokens);
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
