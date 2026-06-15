import type { Tool } from "@openomni/protocol";
import { Mcp, PolicyDecision, PolicyEvent, ToolExecution } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { NativeTool, ToolExecutionContext } from "@openomni/openomni";
import { McpPrefixGuardMiddleware } from "./mcp-prefix-guard";
import { MCP_TOOL_ACTION, buildActor, readSessionId } from "./provider-audit";
import { createResultSummary } from "./provider-metadata";

interface ExecuteMcpToolInput {
  readonly call: Tool.Call;
  readonly context: ToolExecutionContext | undefined;
  readonly tools: NativeTool[];
  readonly isServerConnected: (serverName: string) => boolean;
}

export async function executeMcpTool(input: ExecuteMcpToolInput): Promise<Tool.Result> {
  const { call, context } = input;
  const guard = await McpPrefixGuardMiddleware.evaluatePreToolUse({
    call,
    tools: input.tools,
    isServerConnected: input.isServerConnected,
  });
  const tool = guard.tool;
  if (PolicyDecision.isBlocking(guard.verdict) || !tool) {
    return publishBlockedResult(
      call,
      tool,
      PolicyDecision.reason(guard.verdict, `Unknown tool: ${call.tool}`),
    );
  }

  const sessionId = readSessionId(call) ?? "";
  const actionId = crypto.randomUUID();
  const actor = buildActor(sessionId);

  Bus.publish(PolicyEvent.ActionRequested, {
    traceId: crypto.randomUUID(),
    sessionId,
    time: Date.now(),
    actionId,
    actor,
    action: MCP_TOOL_ACTION,
    resource: tool.spec.name,
    context: { input: call.input },
  });

  const startTime = Date.now();
  const result = await (context === undefined
    ? tool.execute({ ...call, tool: tool.spec.name })
    : tool.execute({ ...call, tool: tool.spec.name }, context));
  const durationMs = Date.now() - startTime;

  Bus.publish(ToolExecution.Completed, {
    traceId: crypto.randomUUID(),
    sessionId,
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
      traceId: crypto.randomUUID(),
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

function publishBlockedResult(
  call: Tool.Call,
  tool: NativeTool | undefined,
  reason: string,
): Tool.Result {
  const result = {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: reason,
    isError: true,
  };
  const sessionId = readSessionId(call);
  if (sessionId) {
    Bus.publish(PolicyEvent.ActionBlocked, {
      traceId: crypto.randomUUID(),
      sessionId,
      time: Date.now(),
      actionId: crypto.randomUUID(),
      actor: buildActor(sessionId),
      action: MCP_TOOL_ACTION,
      resource: tool?.spec.name ?? call.tool,
      verdict: "deny" as const,
      reason,
    });
  }
  return result;
}
