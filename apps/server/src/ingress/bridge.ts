import { Channel, type Gateway, type Ingress, type Policy, type Wait } from "@openomni/protocol";
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

/**
 * The server's explicit tool-permission ruleset for composed agents (audit
 * batch A): the execution runtime fails CLOSED on an absent permission, so
 * the composition layer must declare its decision. Allow-by-default is that
 * decision here — the tool surface is already constrained by the catalog
 * selection above, and a definition that wants a tighter ruleset declares
 * its own `permissions`.
 */
const DEFAULT_AGENT_TOOL_PERMISSION: Policy.Permission = { action: "tool.call" };

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
  // AgentDef entries keep the DOTTED spec name end-to-end (`message.send`,
  // `grep.search`, …). The provider-wire constraint (`^[a-zA-Z0-9_-]{1,128}$`)
  // is owned solely by the `@openomni/llm` boundary (`assignWireToolNames` in
  // run.ts, #749), which sanitizes only the name crossing to the SDK and
  // records the dotted name back — so policy, dispatch, and the transcript all
  // stay on the native dotted vocabulary.
  const specs = selectedEntries.map((entry) => ({ ...entry.tool.spec }));
  const nativeTools = selectedEntries.map((entry) => entry.tool);

  return {
    model: definition.model,
    systemPrompt: definition.systemPrompt,
    tools: specs,
    budget: definition.budget,
    permissions: definition.permissions ?? DEFAULT_AGENT_TOOL_PERMISSION,
    policyPlan: definition.policyPlan,
    toolConfig: {
      workspaceRoot: deps.workspaceRoot,
    },
    toolExecutorFactory: ({ sessionId, runId, agentName, workspaceRoot, ...delivery }) =>
      createToolExecutor({
        tools: nativeTools,
        config: {
          workspaceRoot,
          // #709: engagementId/actorTrustTier ride the same executor-owned
          // implicit rail as sessionId — injected, never model-supplied.
          runtime: { sessionId, runId, agentName, workspaceRoot, ...delivery },
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

/**
 * The resident AgentDef for an external delivery (#707): identical
 * construction to the pre-flip bridge embedding — same prompt family, same
 * tool catalog, same per-message freshness — now invoked by the brain's
 * Deliver consumer through the injected external agent resolver instead of
 * riding the inbound event across the perimeter.
 */
export function buildResidentAgentDef(deps: BridgeDeps): Ingress.AgentDef {
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
  message: Channel.InboundMessage,
  descriptor: ReturnType<typeof Channel.SurfaceKey.parse>,
) {
  return {
    endpointId: descriptor.namespace || descriptor.surface,
    channelId: descriptor.id ?? message.surfaceKey,
  };
}

function actorMessageCorrelation(
  message: Channel.InboundMessage,
  descriptor: ReturnType<typeof Channel.SurfaceKey.parse>,
  threadId: string | undefined,
): Wait.Correlation {
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
  message: Channel.InboundMessage,
  descriptor: ReturnType<typeof Channel.SurfaceKey.parse>,
  threadId: string | undefined,
): Omit<Ingress.DirectEvent, "mode" | "agent"> {
  return {
    id: message.id,
    // D11: the DirectEvent carries the message's first-frame trace unchanged.
    traceId: message.traceId,
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
      replyToId: message.replyToId,
      threadId,
      raw: message.raw,
      // audit A T1: a trusted internal producer (recovery replay) may mark a
      // re-injected message evidence_only; the gateway floors its routed
      // treatment. Absent for normal traffic.
      ...(message.inboundTreatment === undefined
        ? {}
        : { inboundTreatment: message.inboundTreatment }),
    },
  };
}

/**
 * The gateway-facing inbound event (#707): under the flipped seam the
 * external path no longer embeds the AgentDef at the bridge — brain material
 * never rides the perimeter event. The brain's Deliver consumer resolves the
 * resident agent through the injected resolver built from
 * `buildResidentAgentDef` above (same resolution, new location).
 */
export function buildInboundEvent(message: Channel.InboundMessage): Gateway.DeliveredEvent {
  const descriptor = Channel.SurfaceKey.parse(message.surfaceKey);
  const threadId = message.threadId ?? descriptor.threadId;
  const base = createBaseEvent(message, descriptor, threadId);

  return {
    ...base,
    meta: {
      ...base.meta,
      agentName: "resident",
      correlation: actorMessageCorrelation(message, descriptor, threadId),
    },
    mode: "direct",
  };
}
