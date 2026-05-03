import { Guardrail, type Tool } from "@openomni/protocol";
import { Log } from "@openomni/session";
import { WorkspaceLock } from "../workspace-lock.js";
import type {
  ImplicitInputSource,
  NativeTool,
  ToolExecutorConfig,
  ToolRuntimeContext,
} from "./types.js";

const tierTimeouts: Record<number, number> = {
  0: 30_000,
  1: 30_000,
  2: 60_000,
  3: 120_000,
};
const DEFAULT_TIER_TIMEOUT_MS = 30_000;
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

function getTimeoutMs(riskTier: number, config: ToolExecutorConfig): number {
  const configured =
    riskTier === 0
      ? config.timeoutMs?.tier0
      : riskTier === 1
        ? config.timeoutMs?.tier1
        : riskTier === 2
          ? config.timeoutMs?.tier2
          : undefined;

  return configured ?? tierTimeouts[riskTier] ?? DEFAULT_TIER_TIMEOUT_MS;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = globalThis.setTimeout(() => {
        reject(new Error(`timeout after ${ms}ms`));
      }, ms);

      promise.then(
        () => globalThis.clearTimeout(timer),
        () => globalThis.clearTimeout(timer),
      );
    }),
  ]);
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

    if (tool.riskTier >= 2) {
      Log.warn("executor: high-risk tool execution", {
        toolName: originalName,
        tier: tool.riskTier,
      });
    } else {
      Log.debug("executor: risk tier evaluated", { toolName: originalName, tier: tool.riskTier });
    }

    const timeoutMs = getTimeoutMs(tool.riskTier, config);
    const enrichedCall = injectImplicitInputs(call, tool, runtime);
    const dispatchedCall =
      originalName === enrichedCall.tool ? enrichedCall : { ...enrichedCall, tool: originalName };

    try {
      if (tool.riskTier >= 1 && workspaceRoot) {
        await WorkspaceLock.acquire(workspaceRoot, lockOwnerId);
        try {
          return await withTimeout(tool.execute(dispatchedCall), timeoutMs);
        } finally {
          WorkspaceLock.release(workspaceRoot, lockOwnerId);
        }
      }
      return await withTimeout(tool.execute(dispatchedCall), timeoutMs);
    } catch (error) {
      return createErrorResult(call, error instanceof Error ? error.message : String(error));
    }
  };
}
