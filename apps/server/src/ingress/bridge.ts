import type { Tool, Adapter, Ingress } from "@openomni/protocol";
import { SurfaceKey } from "@openomni/session";
import type { AgentToolProvider, SystemToolProvider } from "@openomni/openomni";
import { buildToolCatalog, resolveToolSelection } from "@openomni/openomni";
import { getAgentDefinition } from "../agents/registry";
import type { AgentDefinition } from "../agents/types";
import type { McpToolProvider } from "../tool/mcp/provider";
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
    tools: { all: false },
    budget: { maxTurns: 10 },
  };
}

function selectTools(definition: AgentDefinition, deps: BridgeDeps): Tool.Spec[] {
  const catalog = buildToolCatalog([
    { tools: deps.systemProvider.listTools(), source: "system" },
    { tools: deps.agentProvider.listTools(), source: "agent" },
    { tools: deps.mcpProvider.listTools(), source: "mcp" },
  ]);

  const selected = resolveToolSelection(catalog, definition.tools);
  return selected.map((entry) => ({
    ...entry.tool.spec,
    name: sanitizeToolName(entry.tool.spec.name),
  }));
}

function buildAgentDef(agentName: string, deps: BridgeDeps): Ingress.AgentDef {
  const definition = getAgentDefinition(agentName) ?? createFallbackDefinition(agentName, deps);
  const specs = selectTools(definition, deps);

  return {
    model: definition.model,
    systemPrompt: definition.systemPrompt,
    tools: specs,
    budget: definition.budget,
    permissions: definition.permissions,
    toolConfig: {
      workspaceRoot: deps.workspaceRoot,
    },
  };
}

function createBaseEvent(
  message: Adapter.InboundMessage,
  payload: string,
): Omit<Ingress.InboundEvent, "mode" | "agent" | "agents"> {
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
): Ingress.InboundEvent {
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
