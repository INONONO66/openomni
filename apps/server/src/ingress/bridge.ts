import { Adapter, type Dispatch, type Ingress } from "@openomni/protocol";
import type { NativeTool } from "@openomni/openomni";
import {
  buildToolCatalog,
  createToolExecutor,
  DEFAULT_DISPATCH_MODEL,
  ResidentAgent,
  resolveToolSelection,
} from "@openomni/openomni";
import { getAgentDefinition } from "../agents/registry";
import type { AgentDefinition } from "../agents/types";
import type { McpToolProvider } from "../tool/mcp/provider";

export interface BridgeDeps {
  systemProvider: ToolListProvider;
  agentProvider: ToolListProvider;
  mcpProvider: ToolListProvider;
  customProvider?: { listTools(): NativeTool[] };
  defaultModel?: { provider: string; id: string };
  providerOptions?: Record<string, unknown>;
  workspaceRoot: string;
}

type ToolListProvider = Pick<McpToolProvider, "listTools">;

function sanitizeToolName(name: string): string {
  return name.replace(/\./g, "_");
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
    policyPlan: definition.policyPlan,
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
    ...(deps.providerOptions ? { providerOptions: deps.providerOptions } : {}),
  };
}

export function buildAgentDef(agentName: string, deps: BridgeDeps): Ingress.AgentDef {
  const definition = getAgentDefinition(agentName);
  if (!definition) throw new Error(`Unknown agent definition: ${agentName}`);
  return buildAgentDefFromEntries(definition, deps, selectToolEntries(definition, deps));
}

function buildResidentAgentDef(deps: BridgeDeps): Ingress.AgentDef {
  const model = deps.defaultModel ?? DEFAULT_DISPATCH_MODEL;
  const definition: AgentDefinition = {
    name: "resident",
    description: "Resident user-facing assistant",
    model,
    systemPrompt: ResidentAgent.getPrompt({ model }),
    tools: { categories: ["filesystem", "execution", "delegation", "mcp", "custom"] },
  };
  return buildAgentDefFromEntries(definition, deps, selectToolEntries(definition, deps));
}

function rawCorrelationToken(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || !("correlationToken" in raw)) return undefined;
  const token = (raw as { correlationToken?: unknown }).correlationToken;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

function scopedCorrelation(
  message: Adapter.InboundMessage,
  descriptor: ReturnType<typeof Adapter.SurfaceKey.parse>,
) {
  return {
    endpointId: descriptor.namespace || descriptor.surface,
    channelId: descriptor.id ?? message.surfaceKey,
  };
}

function actorMessageCorrelation(
  message: Adapter.InboundMessage,
  descriptor: ReturnType<typeof Adapter.SurfaceKey.parse>,
  threadId: string | undefined,
): Dispatch.Correlation {
  const token = rawCorrelationToken(message.raw);
  return {
    ...scopedCorrelation(message, descriptor),
    ...(message.replyToId ? { replyToMessageId: message.replyToId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(token ? { tokenHash: token } : {}),
    externalConversationId: message.surfaceKey,
  };
}

function createBaseEvent(
  message: Adapter.InboundMessage,
  descriptor: ReturnType<typeof Adapter.SurfaceKey.parse>,
  threadId: string | undefined,
): Omit<Ingress.DirectEvent, "mode" | "agent"> {
  return {
    id: message.id,
    surface: descriptor.surface,
    workspace: descriptor.namespace || undefined,
    channel: descriptor.id ?? undefined,
    userId: message.sender.id,
    payload: message.text,
    meta: {
      actor: {
        role: "user",
        id: message.sender.id,
      },
      surfaceKey: message.surfaceKey,
      kind: descriptor.kind,
      sender: message.sender,
      media: message.media,
      replyToId: message.replyToId,
      threadId,
      raw: message.raw,
    },
  };
}

export function buildInboundEvent(
  message: Adapter.InboundMessage,
  deps: BridgeDeps,
): Ingress.DirectEvent {
  const descriptor = Adapter.SurfaceKey.parse(message.surfaceKey);
  const threadId = message.threadId ?? descriptor.threadId;
  const base = createBaseEvent(message, descriptor, threadId);
  const agent = buildResidentAgentDef(deps);

  return {
    ...base,
    meta: {
      ...base.meta,
      agentName: "resident",
      correlation: actorMessageCorrelation(message, descriptor, threadId),
    },
    mode: "direct",
    agent,
  };
}
