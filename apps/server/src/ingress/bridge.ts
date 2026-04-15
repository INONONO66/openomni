import type { Tool, Adapter, AgentDef, InboundEvent } from "@openomni/protocol";
import { SurfaceKey } from "@openomni/session";
import { getAgentDefinition } from "../agents/registry";
import type { AgentDefinition } from "../agents/types";
import { createToolExecutor } from "../tool/executor";
import type { NativeTool } from "../tool/types";
import type { AgentToolProvider } from "../tool/agent/provider";
import type { McpToolProvider } from "../tool/mcp/provider";
import type { SystemToolProvider } from "../tool/system/provider";
import { detectMode } from "./mode";

const fallbackModel = { provider: "anthropic", id: "claude-3-haiku-20240307" };

export interface BridgeDeps {
  systemProvider: SystemToolProvider;
  agentProvider: AgentToolProvider;
  mcpProvider: McpToolProvider;
  defaultModel?: { provider: string; id: string };
  workspaceRoot: string;
}

function sanitizeToolName(name: string): string {
  return name.replace(/\./g, "_");
}

function createFallbackDefinition(agentName: string, deps: BridgeDeps): AgentDefinition {
  return {
    name: agentName,
    description: "fallback agent",
    model: deps.defaultModel ?? fallbackModel,
    systemPrompt: "You are a helpful assistant.",
    tools: { system: false, agent: false, mcp: false },
    budget: { maxTurns: 10 },
  };
}

function selectTools(
  definition: AgentDefinition,
  deps: BridgeDeps,
): { specs: Tool.Spec[]; tools: NativeTool[] } {
  const tools: NativeTool[] = [];
  const specs: Tool.Spec[] = [];

  function addTools(providerTools: NativeTool[], selection: boolean | string[] | undefined): void {
    if (!selection) return;

    const selected =
      selection === true
        ? providerTools
        : providerTools.filter((tool) => new Set(selection).has(tool.spec.name));

    tools.push(...selected);
    specs.push(
      ...selected.map((tool) => ({ ...tool.spec, name: sanitizeToolName(tool.spec.name) })),
    );
  }

  addTools(deps.systemProvider.listTools(), definition.tools.system);
  addTools(deps.agentProvider.listTools(), definition.tools.agent);
  addTools(deps.mcpProvider.listTools(), definition.tools.mcp);

  return { specs, tools };
}

function buildAgentDef(agentName: string, deps: BridgeDeps): AgentDef {
  const definition = getAgentDefinition(agentName) ?? createFallbackDefinition(agentName, deps);
  const { specs, tools } = selectTools(definition, deps);

  return {
    model: definition.model,
    systemPrompt: definition.systemPrompt,
    tools: specs,
    budget: definition.budget,
    toolExecutor: createToolExecutor({
      tools,
      config: {
        permissions: definition.permissions,
        workspaceRoot: deps.workspaceRoot,
      },
    }),
  };
}

function createBaseEvent(
  message: Adapter.InboundMessage,
  payload: string,
): Omit<InboundEvent, "mode" | "agent" | "agents"> {
  const descriptor = SurfaceKey.parse(message.surfaceKey);

  return {
    id: message.id,
    surface: descriptor.surface,
    workspace: descriptor.namespace || undefined,
    channel: descriptor.id ?? undefined,
    userId: message.sender.id,
    payload,
    meta: {
      surfaceKey: message.surfaceKey,
      kind: descriptor.kind,
      sender: message.sender,
      media: message.media,
      replyToId: message.replyToId,
      threadId: message.threadId ?? descriptor.threadId,
      raw: message.raw,
    },
  };
}

export function buildInboundEvent(
  message: Adapter.InboundMessage,
  agentName: string,
  deps: BridgeDeps,
): InboundEvent {
  const mode = detectMode(message.text);
  const base = createBaseEvent(message, mode.text);
  const agent = buildAgentDef(agentName, deps);

  if (mode.mode === "plan") {
    return {
      ...base,
      mode: "plan",
      agent,
    };
  }

  return {
    ...base,
    mode: "direct",
    agent,
  };
}
