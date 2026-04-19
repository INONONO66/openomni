import type { Guardrail, Tool } from "@openomni/protocol";
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

function matchesPattern(toolName: string, pattern: string): boolean {
  if (pattern.endsWith(".*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }

  return toolName === pattern;
}

function checkPermission(
  toolName: string,
  permission: Guardrail.ToolPermission | undefined,
): "allow" | "deny" | "require_approval" {
  if (!permission) {
    return "allow";
  }

  if (permission.denylist?.some((pattern) => matchesPattern(toolName, pattern))) {
    return "deny";
  }

  if (
    permission.allowlist &&
    !permission.allowlist.some((pattern) => matchesPattern(toolName, pattern))
  ) {
    return "deny";
  }

  if (permission.requireApproval?.some((pattern) => matchesPattern(toolName, pattern))) {
    return "require_approval";
  }

  return "allow";
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

  return configured ?? tierTimeouts[riskTier] ?? tierTimeouts[0];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = globalThis.setTimeout(() => {
        reject(new Error(`timeout after ${ms}ms`));
      }, ms);

      promise.finally(() => globalThis.clearTimeout(timer)).catch(() => undefined);
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
    const verdict = checkPermission(originalName, config.permissions);
    if (verdict === "deny") {
      Log.warn("executor: permission denied", { toolName: originalName });
      return createErrorResult(call, `[Blocked] Tool "${originalName}" denied by policy`);
    }

    if (verdict === "require_approval") {
      Log.warn("executor: approval required", { toolName: originalName });
      return createErrorResult(call, `[Blocked] Tool "${originalName}" requires approval`);
    }

    Log.debug("executor: risk tier evaluated", { toolName: originalName, tier: tool.riskTier });

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
