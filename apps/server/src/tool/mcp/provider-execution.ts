import type { Tool } from "@openomni/protocol";
import { Mcp, PolicyDecision, PolicyEvent, ToolExecution } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { NativeTool, ToolExecutionContext } from "@openomni/openomni";
import { McpPrefixGuardMiddleware } from "./mcp-prefix-guard";
import { MCP_TOOL_ACTION, buildActor } from "./provider-audit";
import { createResultSummary } from "./provider-metadata";

interface ExecuteMcpToolInput {
  readonly call: Tool.Call;
  readonly context: ToolExecutionContext | undefined;
  readonly tools: NativeTool[];
  readonly isServerConnected: (serverName: string) => boolean;
}

type ExecutionAudit = ReturnType<typeof McpPrefixGuardMiddleware.normalizeAuditContext>;

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

  const startTime = Date.now();
  const result = await tool.execute({ ...call, tool: tool.spec.name }, executionContext);
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
    const serverName = tool.spec.name.split(".")[0] ?? "unknown";

    Bus.publish(Mcp.ToolCompleted, {
      traceId: audit.traceId,
      serverName,
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
