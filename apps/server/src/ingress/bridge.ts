import type { Adapter, Ingress } from "@openomni/protocol";
import { SurfaceKey } from "@openomni/session";
import type { AgentToolProvider, NativeTool, SystemToolProvider } from "@openomni/openomni";
import { buildToolCatalog, createToolExecutor, resolveToolSelection } from "@openomni/openomni";
import { getAgentDefinition } from "../agents/registry";
import type { AgentDefinition } from "../agents/types";
import type { McpToolProvider } from "../tool/mcp/provider";
const fallbackModel = { provider: "anthropic", id: "claude-3-haiku-20240307" };
const mainWorkerControlTools = new Set([
  "spawn_worker",
  "send_worker_message",
  "cancel_worker",
  "resume_worker",
]);

export interface BridgeDeps {
  systemProvider: SystemToolProvider;
  agentProvider: AgentToolProvider;
  mcpProvider: McpToolProvider;
  customProvider?: { listTools(): NativeTool[] };
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

function selectToolEntries(definition: AgentDefinition, deps: BridgeDeps) {
  const catalog = buildToolCatalog([
    { tools: deps.systemProvider.listTools(), source: "system" },
    { tools: deps.agentProvider.listTools(), source: "agent" },
    { tools: deps.mcpProvider.listTools(), source: "mcp" },
    ...(deps.customProvider
      ? [{ tools: deps.customProvider.listTools(), source: "server" as const }]
      : []),
  ]);

  return resolveToolSelection(catalog, definition.tools);
}

function buildAgentDefFromEntries(
  definition: AgentDefinition,
  deps: BridgeDeps,
  selectedEntries: ReturnType<typeof selectToolEntries>,
): Ingress.AgentDef {
  const specs = selectedEntries.map((entry) => ({
    ...entry.tool.spec,
    name: sanitizeToolName(entry.tool.spec.name),
  }));
  const nativeTools = selectedEntries.map((entry) => entry.tool);

  return {
    model: definition.model,
    systemPrompt: definition.systemPrompt,
    tools: specs,
    budget: definition.budget,
    permissions: definition.permissions,
    toolConfig: {
      workspaceRoot: deps.workspaceRoot,
    },
    toolExecutorFactory: ({ sessionId, runId, agentName, workspaceRoot }) =>
      createToolExecutor({
        tools: nativeTools,
        config: {
          workspaceRoot,
          runtime: { sessionId, runId, agentName, workspaceRoot },
        },
      }),
  };
}

export function buildAgentDef(agentName: string, deps: BridgeDeps): Ingress.AgentDef {
  const definition = getAgentDefinition(agentName) ?? createFallbackDefinition(agentName, deps);
  return buildAgentDefFromEntries(definition, deps, selectToolEntries(definition, deps));
}

export function buildMainAgentDef(agentName: string, deps: BridgeDeps): Ingress.AgentDef {
  const definition = getAgentDefinition(agentName) ?? createFallbackDefinition(agentName, deps);
  const mainEntries = selectToolEntries(
    { ...definition, tools: { categories: ["custom"] } },
    deps,
  ).filter(
    (entry) => entry.source === "server" && mainWorkerControlTools.has(entry.tool.spec.name),
  );
  return buildAgentDefFromEntries(definition, deps, mainEntries);
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
    target: { kind: "main" },
    meta: {
      actor: {
        role: "user",
        id: message.sender.id,
      },
      target: {
        kind: "main",
      },
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
  const base = createBaseEvent(message, message.text);
  const agent = buildMainAgentDef(agentName, deps);

  return {
    ...base,
    meta: {
      ...base.meta,
      agentName,
    },
    mode: "direct",
    agent,
  };
}
