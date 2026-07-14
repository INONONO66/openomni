import type { Policy, RuntimeResource, Tool } from "@openomni/protocol";
import type { AgentStep, TokenUsage } from "../types";
import type { PolicyEngineInstance } from "../policy";
import type { PolicyContext } from "../policy/types";

export interface ToolPolicyRunContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly steps: AgentStep[];
  readonly turnCount: number;
  readonly elapsedMs: number;
  readonly usage: TokenUsage;
}

interface ToolPolicyTarget {
  readonly descriptor: RuntimeResource.Descriptor;
  readonly kind: "native" | "mcp";
  readonly mcpServerId?: string;
}

function mcpServerId(labels: readonly string[] | undefined): string | undefined {
  return labels?.find((label) => label.startsWith("mcp."))?.slice("mcp.".length);
}

function sourceFromLabels(
  labels: readonly string[] | undefined,
): RuntimeResource.Source | undefined {
  const sourceLabel = labels?.find(
    (label) => label.startsWith("source.") || label.startsWith("source:"),
  );
  const sourceType = sourceLabel?.replace(/^source[.:]/, "");
  if (sourceType === "mcp" || sourceType === "skill-mcp") {
    const serverId = mcpServerId(labels);
    return serverId === undefined ? { type: sourceType } : { type: sourceType, serverId };
  }
  if (sourceType === "agent") return { type: "agent" };
  if (sourceType === "server") return { type: "server" };
  if (sourceType === "system") return { type: "system" };
  return undefined;
}

function policyTarget(
  toolName: string,
  labels: readonly string[] | undefined,
  providedDescriptor: RuntimeResource.Descriptor | undefined,
): ToolPolicyTarget {
  const source = providedDescriptor?.source ?? sourceFromLabels(labels);
  const descriptor: RuntimeResource.Descriptor = providedDescriptor ?? {
    id: source ? `tool:${source.type}:${toolName}` : `tool:${toolName}`,
    kind: "tool",
    labels: labels ? [...labels] : [],
    capabilities: [],
    effects: [],
  };
  if (providedDescriptor === undefined && source !== undefined) descriptor.source = source;
  const serverId =
    source?.type === "mcp" || source?.type === "skill-mcp"
      ? (source.serverId ?? mcpServerId(labels))
      : undefined;
  const kind = source?.type === "mcp" || source?.type === "skill-mcp" ? "mcp" : "native";
  return serverId === undefined
    ? { descriptor, kind }
    : { descriptor, kind, mcpServerId: serverId };
}

function sharedContext(
  context: ToolPolicyRunContext,
): Omit<PolicyContext, "timing"> & Record<string, unknown> {
  return {
    sessionId: context.sessionId,
    runId: context.runId,
    steps: context.steps,
    turnCount: context.turnCount,
    elapsedMs: context.elapsedMs,
    usage: context.usage,
    isCompletion: false,
    continuationCount: 0,
  };
}

export async function dispatchToolPre(
  engine: PolicyEngineInstance,
  context: ToolPolicyRunContext,
  toolName: string,
  call: Tool.Call,
  labels: readonly string[] | undefined,
  descriptor?: RuntimeResource.Descriptor,
): Promise<Policy.PolicyDecision> {
  const target = policyTarget(toolName, labels, descriptor);
  const input = {
    ...sharedContext(context),
    toolId: toolName,
    toolName,
    toolCallId: call.id,
    toolLabels: labels === undefined ? undefined : [...labels],
    toolInput: call.input,
    resourceDescriptor: target.descriptor,
  };
  if (target.kind === "mcp") {
    return engine.dispatchPoint("tool.mcp.pre", {
      ...input,
      mcpServerId: target.mcpServerId,
    });
  }
  return engine.dispatchPoint("tool.native.pre", input);
}

export async function dispatchToolPost(
  engine: PolicyEngineInstance,
  context: ToolPolicyRunContext,
  toolName: string,
  call: Tool.Call,
  result: Tool.Result,
  labels: readonly string[] | undefined,
  descriptor?: RuntimeResource.Descriptor,
): Promise<Policy.PolicyDecision> {
  const target = policyTarget(toolName, labels, descriptor);
  const input = {
    ...sharedContext(context),
    toolId: toolName,
    toolName,
    toolCallId: call.id,
    toolLabels: labels === undefined ? undefined : [...labels],
    toolOutput: result.output,
    toolResult: result,
    resourceDescriptor: target.descriptor,
  };
  if (target.kind === "mcp") {
    return engine.dispatchPoint("tool.mcp.post", {
      ...input,
      mcpServerId: target.mcpServerId,
    });
  }
  return engine.dispatchPoint("tool.native.post", input);
}
