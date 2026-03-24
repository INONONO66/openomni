import type { Tool } from "@openomni/protocol";
import { ChatAgent } from "../../core/chat-agent";
import { checkDelegation, type DelegationContext } from "../../core/delegation";
import { AgentRegistry } from "../registry/registry";
import { AgentMessenger } from "../messenger/messenger";
import { BusTransport } from "../messenger/transport";

export interface SubagentToolOptions {
  delegationContext?: DelegationContext;
  messengerAllowPatterns?: Array<{ from: string; to: string }>;
}

export interface SubagentToolSpec {
  spec: Tool.Spec;
  execute: (args: unknown) => Promise<Tool.Result>;
}

export namespace SubagentTool {
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
            description: "Optional session ID for context continuity",
          },
        },
        required: ["agentName", "prompt"],
      },
    };

    const execute = async (args: unknown): Promise<Tool.Result> => {
      const { agentName, prompt } = args as {
        agentName: string;
        prompt: string;
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

      const childAbort = ctx?.parentAbort
        ? AbortSignal.any([ctx.parentAbort])
        : undefined;

      try {
        const childAgent = ChatAgent.create({
          model: definition.model ?? {
            provider: "anthropic",
            id: "claude-3-haiku-20240307",
          },
          systemPrompt: definition.systemPrompt,
          budget: definition.maxTurns
            ? { maxTurns: definition.maxTurns }
            : undefined,
          permissions: definition.permissions,
          signal: childAbort,
        });

        const result = await childAgent.run({
          messages: [{ role: "user", content: prompt }],
        });

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
