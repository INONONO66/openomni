import type { Adapter, Ingress } from "@openomni/protocol";
import { PendingAskStore, SurfaceKey } from "@openomni/session";
import type { NativeTool } from "@openomni/openomni";
import {
  buildToolCatalog,
  createToolExecutor,
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

export function buildResidentAgentDef(_agentName: string, deps: BridgeDeps): Ingress.AgentDef {
  const model = deps.defaultModel ?? { provider: "anthropic", id: "claude-3-5-sonnet-20241022" };
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

function findPendingAskForMessage(message: Adapter.InboundMessage) {
  const token = rawCorrelationToken(message.raw);
  const descriptor = SurfaceKey.parse(message.surfaceKey);
  const channelId = descriptor.id;
  const scoped = {
    endpointId: descriptor.namespace || descriptor.surface,
    ...(channelId ? { channelId } : {}),
  };
  type CorrelationQuery = Parameters<typeof PendingAskStore.findByCorrelation>[0];
  const queries: CorrelationQuery[] = [];
  if (token) queries.push({ tokenHash: token });
  queries.push({ ...scoped, externalConversationId: message.surfaceKey });
  if (message.replyToId) queries.push({ ...scoped, replyToMessageId: message.replyToId });
  if (message.threadId) queries.push({ ...scoped, threadId: message.threadId });
  if (message.id) queries.push({ ...scoped, externalMessageId: message.id });

  const seen = new Set<string>();
  const matches: ReturnType<typeof PendingAskStore.findByCorrelation> = [];
  for (const query of queries) {
    for (const ask of PendingAskStore.findByCorrelation(query)) {
      if (seen.has(ask.id)) continue;
      seen.add(ask.id);
      matches.push(ask);
    }
  }

  if (matches.length > 1) {
    for (const ask of matches) {
      PendingAskStore.markAmbiguous(ask.id);
    }
    return {
      ids: matches.map((ask) => ask.id),
      status: "ambiguous",
      ambiguous: true,
    };
  }

  const ask = matches[0];
  if (!ask) return undefined;
  return {
    id: ask.id,
    originSessionId: ask.originSessionId,
    ...(ask.originRunId ? { originRunId: ask.originRunId } : {}),
    originActorKind: ask.originActorKind,
    targetKind: ask.targetKind,
    status: matches.length > 1 ? "ambiguous" : ask.status,
    ambiguous: matches.length > 1,
  };
}

function createBaseEvent(
  message: Adapter.InboundMessage,
  payload: string,
): Omit<Ingress.DirectEvent, "mode" | "agent"> {
  const descriptor = SurfaceKey.parse(message.surfaceKey);

  return {
    id: message.id,
    surface: descriptor.surface,
    workspace: descriptor.namespace || undefined,
    channel: descriptor.id ?? undefined,
    userId: message.sender.id,
    payload,
    target: { kind: "resident" },
    meta: {
      actor: {
        role: "user",
        id: message.sender.id,
      },
      target: {
        kind: "resident",
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
  _agentName: string,
  deps: BridgeDeps,
): Ingress.DirectEvent {
  const base = createBaseEvent(message, message.text);
  const pendingAsk = findPendingAskForMessage(message);
  const agent = buildResidentAgentDef("resident", deps);

  return {
    ...base,
    meta: {
      ...base.meta,
      agentName: "resident",
      ...(pendingAsk ? { pendingAsk } : {}),
    },
    mode: "direct",
    agent,
  };
}
