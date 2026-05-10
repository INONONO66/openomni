import { Guardrail, PolicyEvent, ToolExecution, type Hook, type Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
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
  if (result.decision === "require_approval") {
    return `[Blocked] Tool "${toolName}" requires approval: ${result.reason}`;
  }

  if (result.decision === "deny") {
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

function buildActor(runtime: ToolRuntimeContext | undefined): Record<string, unknown> {
  return {
    kind: "agent",
    ...(runtime?.agentName !== undefined && { agentName: runtime.agentName }),
    ...(runtime?.sessionId !== undefined && { sessionId: runtime.sessionId }),
    ...(runtime?.runId !== undefined && { runId: runtime.runId }),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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

function publishPolicyEvaluated(
  base: { traceId: string; sessionId: string; runId?: string; time: number },
  actor: Record<string, unknown>,
  resource: string,
  verdict: Hook.Verdict,
): void {
  Bus.publish(PolicyEvent.Evaluated, {
    ...base,
    policyId: verdict.policyId ?? "tool.runtime-policy",
    actor,
    action: TOOL_CALL_ACTION,
    resource,
    verdict: verdict.action,
    reason: verdict.reason ?? "runtime policy evaluated",
  });
}

export function createToolExecutor(
  ctx: ToolExecutorContext,
): (call: Tool.Call) => Promise<Tool.Result> {
  const dispatch = buildDispatchTable(ctx.tools);
  const config = ctx.config ?? {};
  const { workspaceRoot } = config;
  const lockOwnerId = crypto.randomUUID();
  const runtime = config.runtime;

  function eventBase() {
    return {
      traceId: crypto.randomUUID(),
      sessionId: runtime?.sessionId ?? "",
      ...(runtime?.runId !== undefined && { runId: runtime.runId }),
      time: Date.now(),
    };
  }

  return async (call: Tool.Call): Promise<Tool.Result> => {
    const tool = dispatch.get(call.tool);
    if (!tool) {
      return createErrorResult(call, `Unknown tool: ${call.tool}`);
    }

    const originalName = tool.spec.name;
    const actionId = crypto.randomUUID();
    const actor = buildActor(runtime);

    Bus.publish(PolicyEvent.ActionRequested, {
      ...eventBase(),
      actionId,
      actor,
      action: TOOL_CALL_ACTION,
      resource: originalName,
      context: { input: call.input },
    });

    const permissionResult = evaluatePermission(originalName, call.input, config.permissions);
    if (config.permissions) {
      Bus.publish(PolicyEvent.Evaluated, {
        ...eventBase(),
        policyId: permissionResult.policyId,
        actor,
        action: TOOL_CALL_ACTION,
        resource: originalName,
        verdict: permissionResult.action,
        reason: permissionResult.reason,
      });
    }

    if (permissionResult.action === "abort") {
      const result = createErrorResult(
        call,
        permissionErrorMessage(originalName, permissionResult),
      );
      Bus.publish(PolicyEvent.ActionBlocked, {
        ...eventBase(),
        actionId,
        actor,
        action: TOOL_CALL_ACTION,
        resource: originalName,
        verdict: permissionResult.action,
        reason: permissionResult.reason,
      });
      Bus.publish(ToolExecution.Completed, {
        ...eventBase(),
        actor,
        toolCallId: call.id,
        toolName: originalName,
        durationMs: 0,
        isError: true,
      });
      return result;
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

      publishPolicyEvaluated(eventBase(), actor, originalName, policy.verdict);

      if (policy.verdict.action !== "continue") {
        const result = createErrorResult(
          call,
          policy.verdict.reason ?? "tool runtime policy aborted",
        );
        Bus.publish(PolicyEvent.ActionBlocked, {
          ...eventBase(),
          actionId,
          actor,
          action: TOOL_CALL_ACTION,
          resource: originalName,
          verdict: policy.verdict.action,
          reason: policy.verdict.reason ?? "tool runtime policy aborted",
        });
        Bus.publish(ToolExecution.Completed, {
          ...eventBase(),
          actor,
          toolCallId: call.id,
          toolName: originalName,
          durationMs: 0,
          isError: true,
        });
        return result;
      }

      const startTime = Date.now();
      Bus.publish(ToolExecution.Started, {
        ...eventBase(),
        actor,
        toolCallId: call.id,
        toolName: originalName,
      });

      const result = await ToolRuntimePolicyMiddleware.enforceTimeout(
        tool.execute(dispatchedCall),
        policy.handle.timeoutMs,
      );
      const durationMs = Date.now() - startTime;

      const postVerdict = await ToolRuntimePolicyMiddleware.evaluatePostTool({
        toolName: originalName,
        toolCallId: call.id,
        input: dispatchedCall.input,
        output: result.output,
        handle: policy.handle,
      });
      publishPolicyEvaluated(eventBase(), actor, originalName, postVerdict);

      Bus.publish(ToolExecution.Completed, {
        ...eventBase(),
        actor,
        toolCallId: call.id,
        toolName: originalName,
        durationMs,
        isError: result.isError ?? false,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = error instanceof ToolRuntimePolicyMiddleware.TimeoutError;
      const isAbort = isAbortError(error);

      if (isTimeout && policy) {
        const timeoutMs = (error as ToolRuntimePolicyMiddleware.TimeoutError).timeoutMs;
        Bus.publish(ToolExecution.TimedOut, {
          ...eventBase(),
          toolCallId: call.id,
          toolName: originalName,
          timeoutMs,
        });
      }

      if (policy?.verdict.action === "continue") {
        const postVerdict = await ToolRuntimePolicyMiddleware.evaluatePostTool({
          toolName: originalName,
          toolCallId: call.id,
          input: dispatchedCall.input,
          output: message,
          handle: policy.handle,
        });
        publishPolicyEvaluated(eventBase(), actor, originalName, postVerdict);
      }

      const result = createErrorResult(call, message);
      if (isTimeout || isAbort) {
        Bus.publish(PolicyEvent.ActionBlocked, {
          ...eventBase(),
          actionId,
          actor,
          action: TOOL_CALL_ACTION,
          resource: originalName,
          verdict: "abort" as const,
          reason: message,
        });
      }
      Bus.publish(ToolExecution.Completed, {
        ...eventBase(),
        actor,
        toolCallId: call.id,
        toolName: originalName,
        durationMs: 0,
        isError: true,
      });
      return result;
    }
  };
}
