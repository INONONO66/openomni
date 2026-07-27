import { Execution, type Tool } from "@openomni/protocol";
import { Mcp, PolicyDecision, PolicyEvent, ToolExecution } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import {
  digestEffectValue,
  toWorkspaceRef,
  type NativeTool,
  type ToolEffectLedgerPortV1,
  type ToolExecutionContext,
  type WorkspaceIdentity,
} from "@openomni/openomni";
import { McpPrefixGuardMiddleware } from "./mcp-prefix-guard";
import { MCP_TOOL_ACTION, buildActor } from "./provider-audit";
import { createResultSummary } from "./provider-metadata";

interface ExecuteMcpToolInput {
  readonly call: Tool.Call;
  readonly context: ToolExecutionContext | undefined;
  readonly tools: NativeTool[];
  readonly isServerConnected: (serverName: string) => boolean;
  readonly effects: ToolEffectLedgerPortV1;
  readonly workspaceIdentity: WorkspaceIdentity;
}

type ExecutionAudit = ReturnType<typeof McpPrefixGuardMiddleware.normalizeAuditContext>;

function canonicalEffectValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEffectValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalEffectValue(nested)]),
    );
  }
  return value;
}

function requireAcceptedEffectReceipt(
  receipt: Awaited<ReturnType<ToolEffectLedgerPortV1["appendIntent"]>>,
): void {
  if (receipt.version === "tool-effect-append-receipt-v1" && receipt.status === "accepted") return;
  throw new Error(
    `effect ledger denied: ${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ""}`,
  );
}

function mcpEffectScope(input: {
  readonly call: Tool.Call;
  readonly tool: NativeTool;
  readonly serverName: string;
  readonly workspace: WorkspaceIdentity;
}): Execution.EffectScopeV1 {
  const inputDigest = digestEffectValue(JSON.stringify(canonicalEffectValue(input.call.input)));
  return Execution.EffectScopeV1.parse({
    version: "effect-scope-v1",
    workspace: toWorkspaceRef(input.workspace),
    resources: [
      {
        version: "resource-scope-v1",
        kind: "endpoint",
        targetDigest: digestEffectValue(input.serverName),
      },
      {
        version: "resource-scope-v1",
        kind: "registered",
        variant: "mcp.v1",
        targetDigest: digestEffectValue(input.tool.spec.name),
      },
    ],
    resolver: { id: "mcp-registered-tool-v1", version: "1", inputDigest },
    containment: "none",
    mutationClass: "mutating",
  });
}

function mcpEffectIntent(input: {
  readonly call: Tool.Call;
  readonly tool: NativeTool;
  readonly serverName: string;
  readonly workspace: WorkspaceIdentity;
  readonly audit: ExecutionAudit;
}) {
  const scope = mcpEffectScope(input);
  const sourceRef = digestEffectValue(
    JSON.stringify({
      version: "tool-effect-source-v1",
      sessionId: input.audit.sessionId,
      runId: input.audit.runId,
      toolCallId: input.call.id,
      operation: input.tool.spec.name,
      operationVersion: "1",
      scope,
    }),
  );
  return Object.freeze({
    version: "tool-effect-intent-v1" as const,
    effectId: `tool-effect:${sourceRef}`,
    sourceRef,
    toolCallId: input.call.id,
    operation: input.tool.spec.name,
    operationVersion: "1" as const,
    scope,
    execution: { sessionId: input.audit.sessionId, runId: input.audit.runId },
  });
}

async function settleMcpEffect(
  effects: ToolEffectLedgerPortV1,
  intent: ReturnType<typeof mcpEffectIntent>,
  status: "confirmed" | "failed" | "unknown",
): Promise<void> {
  requireAcceptedEffectReceipt(
    await effects.appendSettlement({
      version: "tool-effect-settlement-v1",
      effectId: intent.effectId,
      sourceRef: intent.sourceRef,
      status,
    }),
  );
}

export async function executeMcpTool(input: ExecuteMcpToolInput): Promise<Tool.Result> {
  const { call, context } = input;
  const audit = McpPrefixGuardMiddleware.normalizeAuditContext(context?.traceContext);
  const executionContext: ToolExecutionContext = {
    ...(context?.signal !== undefined && { signal: context.signal }),
    traceContext: audit,
  };
  const guard = await McpPrefixGuardMiddleware.evaluatePreToolUse({
    call,
    tools: input.tools,
    isServerConnected: input.isServerConnected,
    traceContext: executionContext.traceContext,
  });
  const tool = guard.tool;
  if (PolicyDecision.isBlocking(guard.verdict) || !tool) {
    return publishBlockedResult({
      call,
      tool,
      reason: PolicyDecision.reason(guard.verdict, `Unknown tool: ${call.tool}`),
      audit,
    });
  }

  const serverName = guard.serverName;
  if (!serverName) {
    return publishBlockedResult({
      call,
      tool,
      reason: `MCP endpoint unresolved for tool: ${tool.spec.name}`,
      audit,
    });
  }

  const actionId = crypto.randomUUID();
  const actor = buildActor(audit.sessionId);

  Bus.publish(PolicyEvent.ActionRequested, {
    ...audit,
    time: Date.now(),
    actionId,
    actor,
    action: MCP_TOOL_ACTION,
    resource: tool.spec.name,
    context: { input: call.input },
  });

  const intent = mcpEffectIntent({
    call,
    tool,
    serverName,
    workspace: input.workspaceIdentity,
    audit,
  });
  requireAcceptedEffectReceipt(await input.effects.appendIntent(intent));

  const startTime = Date.now();
  let result: Tool.Result;
  try {
    result = await tool.execute({ ...call, tool: tool.spec.name }, executionContext);
  } catch (error) {
    await settleMcpEffect(input.effects, intent, "unknown");
    throw error;
  }
  await settleMcpEffect(
    input.effects,
    intent,
    result.settlement === "unknown" ? "unknown" : result.isError ? "failed" : "confirmed",
  );
  const durationMs = Date.now() - startTime;

  Bus.publish(ToolExecution.Completed, {
    ...audit,
    time: Date.now(),
    actor,
    toolCallId: call.id,
    toolName: tool.spec.name,
    durationMs,
    isError: result.isError ?? false,
  });

  if (!result.isError) {
    const resultSummary = createResultSummary(result.output);
    const completedServerName = serverName;

    Bus.publish(Mcp.ToolCompleted, {
      traceId: audit.traceId,
      serverName: completedServerName,
      toolName: tool.spec.name,
      toolCallId: call.id,
      durationMs,
      resultSummary,
      time: Date.now(),
    });
  }

  return result;
}

function publishBlockedResult(input: {
  readonly call: Tool.Call;
  readonly tool: NativeTool | undefined;
  readonly reason: string;
  readonly audit: ExecutionAudit;
}): Tool.Result {
  const { call, tool, reason, audit } = input;
  const result = {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: reason,
    isError: true,
  };
  Bus.publish(PolicyEvent.ActionBlocked, {
    ...audit,
    time: Date.now(),
    actionId: crypto.randomUUID(),
    actor: buildActor(audit.sessionId),
    action: MCP_TOOL_ACTION,
    resource: tool?.spec.name ?? call.tool,
    verdict: "deny" as const,
    reason,
  });
  return result;
}
