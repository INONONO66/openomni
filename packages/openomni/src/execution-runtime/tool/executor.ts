import { Guardrail, ToolExecution, type Tool } from "@openomni/protocol";
import { Bus, Log } from "@openomni/session";
import { ToolRuntimePolicyMiddleware } from "./middleware/tool-runtime-policy.js";
import type {
  ImplicitInputSource,
  NativeTool,
  ToolExecutorConfig,
  ToolRuntimeContext,
} from "./types.js";

const TOOL_CALL_ACTION = "tool.call";

export interface ToolExecutorContext {
  tools: NativeTool[];
  config?: ToolExecutorConfig;
}

function buildDispatchTable(tools: NativeTool[]): Map<string, NativeTool> {
  const dispatch = new Map<string, NativeTool>();
  for (const tool of tools) {
    dispatch.set(tool.spec.name, tool);
    const sanitized = tool.spec.name.replace(/\./g, "_");
    if (sanitized !== tool.spec.name) dispatch.set(sanitized, tool);
  }
  return dispatch;
}

function normalizePermission(
  permission: Guardrail.Permission | undefined,
): Guardrail.Permission | undefined {
  if (!permission) return undefined;
  if (permission.action) return permission;
  return { ...permission, action: TOOL_CALL_ACTION };
}

function evaluatePermission(
  toolName: string,
  input: Record<string, unknown>,
  permission: Guardrail.Permission | undefined,
): Guardrail.EvaluationResult {
  return Guardrail.evaluate(normalizePermission(permission), {
    action: TOOL_CALL_ACTION,
    resource: toolName,
    input,
  });
}

function permissionErrorMessage(toolName: string, result: Guardrail.EvaluationResult): string {
  if (result.reason === "require_approval" || result.reason === "input_rule_require_approval") {
    return `[Blocked] Tool "${toolName}" requires approval: ${result.reason}`;
  }

  if (result.reason === "denylist" || result.reason === "input_rule_deny") {
    return `[Blocked] Tool "${toolName}" denied by policy: ${result.reason}`;
  }

  return `[Blocked] Tool "${toolName}" blocked by policy: ${result.reason}`;
}

function createErrorResult(call: Tool.Call, message: string): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: message,
    isError: true,
  };
}

function resolveImplicitValue(
  source: ImplicitInputSource,
  runtime: ToolRuntimeContext,
): string | undefined {
  switch (source) {
    case "sessionId":
      return runtime.sessionId;
    case "runId":
      return runtime.runId;
    case "agentName":
      return runtime.agentName;
    case "workspaceRoot":
      return runtime.workspaceRoot;
  }
}

function injectImplicitInputs(
  call: Tool.Call,
  tool: NativeTool,
  runtime: ToolRuntimeContext | undefined,
): Tool.Call {
  if (!tool.implicitInputs || !runtime) return call;

  const injected: Record<string, unknown> = { ...(call.input as Record<string, unknown>) };
  for (const [param, source] of Object.entries(tool.implicitInputs)) {
    const value = resolveImplicitValue(source, runtime);
    if (value !== undefined) injected[param] = value;
  }
  return { ...call, input: injected };
}

export function createToolExecutor(
  ctx: ToolExecutorContext,
): (call: Tool.Call) => Promise<Tool.Result> {
  const dispatch = buildDispatchTable(ctx.tools);
  const config = ctx.config ?? {};
  const { workspaceRoot } = config;
  const lockOwnerId = crypto.randomUUID();

  const runtime = config.runtime;

  return async (call: Tool.Call): Promise<Tool.Result> => {
    const tool = dispatch.get(call.tool);
    if (!tool) {
      return createErrorResult(call, `Unknown tool: ${call.tool}`);
    }

    const originalName = tool.spec.name;
    const permissionResult = evaluatePermission(originalName, call.input, config.permissions);
    if (permissionResult.action === "abort") {
      Log.warn("executor: permission blocked", {
        toolName: originalName,
        reason: permissionResult.reason,
        matchedPattern: permissionResult.matchedPattern,
      });
      return createErrorResult(call, permissionErrorMessage(originalName, permissionResult));
    }

    const enrichedCall = injectImplicitInputs(call, tool, runtime);
    const dispatchedCall =
      originalName === enrichedCall.tool ? enrichedCall : { ...enrichedCall, tool: originalName };
    let policy: ToolRuntimePolicyMiddleware.PreToolResult | undefined;

    try {
      policy = await ToolRuntimePolicyMiddleware.evaluatePreTool({
        toolName: originalName,
        toolCallId: call.id,
        input: dispatchedCall.input,
        riskTier: tool.riskTier,
        timeoutConfig: config.timeoutMs,
        workspaceRoot,
        lockOwnerId,
      });

      if (policy.verdict.action !== "continue") {
        return createErrorResult(call, policy.verdict.reason ?? "tool runtime policy aborted");
      }

      const result = await ToolRuntimePolicyMiddleware.enforceTimeout(
        tool.execute(dispatchedCall),
        policy.handle.timeoutMs,
      );
      await ToolRuntimePolicyMiddleware.evaluatePostTool({
        toolName: originalName,
        toolCallId: call.id,
        input: dispatchedCall.input,
        output: result.output,
        handle: policy.handle,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = error instanceof ToolRuntimePolicyMiddleware.TimeoutError;

      if (isTimeout && policy) {
        const timeoutMs = (error as ToolRuntimePolicyMiddleware.TimeoutError).timeoutMs;
        const sessionId = runtime?.sessionId ?? "";
        Bus.publish(ToolExecution.TimedOut, {
          traceId: crypto.randomUUID(),
          sessionId,
          ...(runtime?.runId !== undefined && { runId: runtime.runId }),
          toolCallId: call.id,
          toolName: originalName,
          timeoutMs,
          time: Date.now(),
        });
      }

      if (policy?.verdict.action === "continue") {
        await ToolRuntimePolicyMiddleware.evaluatePostTool({
          toolName: originalName,
          toolCallId: call.id,
          input: dispatchedCall.input,
          output: message,
          handle: policy.handle,
        });
      }
      return createErrorResult(call, message);
    }
  };
}
