import { createHash } from "node:crypto";
import {
  Operational,
  type Adapter,
  type Dispatch,
  type Ingress,
  SurfaceAddress,
} from "@openomni/protocol";
import { Bus } from "@openomni/session";
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
  defaultModel: { provider: string; id: string } | undefined;
  providerOptions?: Record<string, unknown>;
  workspaceRoot: string;
}

type ToolListProvider = Pick<McpToolProvider, "listTools">;

export type BridgeAgentResolutionErrorCode =
  | "missing_default_model"
  | "invalid_default_model"
  | "unknown_agent";

export class BridgeAgentResolutionError extends Error {
  readonly code: BridgeAgentResolutionErrorCode;
  readonly agentName: string;

  constructor(code: BridgeAgentResolutionErrorCode, agentName: string, message: string) {
    super(message);
    this.name = "BridgeAgentResolutionError";
    this.code = code;
    this.agentName = agentName;
  }
}

function failAgentResolution(
  code: BridgeAgentResolutionErrorCode,
  agentName: string,
  message: string,
): never {
  Bus.publish(Operational.Error, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: "agent resolution failed",
    error: code,
    context: { code, agentName },
  });
  throw new BridgeAgentResolutionError(code, agentName, message);
}

function requireDefaultModel(deps: BridgeDeps): { provider: string; id: string } {
  const model = deps.defaultModel;
  if (model === undefined) {
    return failAgentResolution(
      "missing_default_model",
      "resident",
      "Resident agent requires an explicitly resolved default model",
    );
  }
  if (
    model === null ||
    typeof model !== "object" ||
    typeof model.provider !== "string" ||
    model.provider.length === 0 ||
    model.provider.trim() !== model.provider ||
    typeof model.id !== "string" ||
    model.id.length === 0 ||
    model.id.trim() !== model.id
  ) {
    return failAgentResolution(
      "invalid_default_model",
      "resident",
      "Resident agent default model is invalid",
    );
  }
  return model;
}

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
  if (!definition) {
    return failAgentResolution(
      "unknown_agent",
      agentName,
      `Unknown agent definition: ${agentName}`,
    );
  }
  return buildAgentDefFromEntries(definition, deps, selectToolEntries(definition, deps));
}

export function buildResidentAgentDef(deps: BridgeDeps): Ingress.AgentDef {
  const model = requireDefaultModel(deps);
  const definition: AgentDefinition = {
    name: "resident",
    description: "Resident user-facing assistant",
    model,
    systemPrompt: ResidentAgent.getPrompt({ model }),
    tools: { categories: ["filesystem", "execution", "delegation", "mcp", "custom"] },
  };
  return buildAgentDefFromEntries(definition, deps, selectToolEntries(definition, deps));
}

const CORRELATION_TOKEN_HASH_DOMAIN = "openomni.ingress.correlation-token.v1\0";

function correlationTokenHash(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || !("correlationToken" in raw)) return undefined;
  const token = (raw as { correlationToken?: unknown }).correlationToken;
  if (typeof token !== "string" || token.length === 0) return undefined;
  return createHash("sha256").update(CORRELATION_TOKEN_HASH_DOMAIN).update(token).digest("hex");
}

function withoutCorrelationToken(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("correlationToken" in raw)) {
    return raw;
  }
  const { correlationToken: _correlationToken, ...safeRaw } = raw as Record<string, unknown>;
  return safeRaw;
}

function scopedCorrelation(
  message: Adapter.InboundMessage,
  descriptor: ReturnType<typeof SurfaceAddress.parse>,
) {
  return {
    endpointId: descriptor.namespace || descriptor.surface,
    channelId: descriptor.id ?? message.surfaceKey,
  };
}

function actorMessageCorrelation(
  message: Adapter.InboundMessage,
  descriptor: ReturnType<typeof SurfaceAddress.parse>,
  threadId: string | undefined,
): Dispatch.Correlation {
  const tokenHash = correlationTokenHash(message.raw);
  return {
    ...scopedCorrelation(message, descriptor),
    ...(message.replyToId ? { replyToMessageId: message.replyToId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(tokenHash ? { tokenHash } : {}),
    externalConversationId: message.surfaceKey,
  };
}

function createBaseEvent(
  message: Adapter.InboundMessage,
  descriptor: ReturnType<typeof SurfaceAddress.parse>,
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
      raw: withoutCorrelationToken(message.raw),
    },
  };
}

export function buildInboundEvent(
  message: Adapter.InboundMessage,
  deps: BridgeDeps,
): Ingress.DirectEvent {
  const descriptor = SurfaceAddress.parse(message.surfaceKey);
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
