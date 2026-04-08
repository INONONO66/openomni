import type { Guardrail, Tool } from "@openomni/protocol";
import type { NativeTool, ToolExecutorConfig } from "./types";

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

export function createToolExecutor(
  ctx: ToolExecutorContext,
): (call: Tool.Call) => Promise<Tool.Result> {
  const dispatch = buildDispatchTable(ctx.tools);
  const config = ctx.config ?? {};

  return async (call: Tool.Call): Promise<Tool.Result> => {
    const tool = dispatch.get(call.tool);
    if (!tool) {
      return createErrorResult(call, `Unknown tool: ${call.tool}`);
    }

    const originalName = tool.spec.name;
    const verdict = checkPermission(originalName, config.permissions);
    if (verdict === "deny") {
      return createErrorResult(call, `[Blocked] Tool "${originalName}" denied by policy`);
    }

    if (verdict === "require_approval") {
      return createErrorResult(call, `[Blocked] Tool "${originalName}" requires approval`);
    }

    if (tool.riskTier >= 2) {
      console.warn(`[executor] executing tier-${tool.riskTier} tool: ${originalName}`);
    }

    const timeoutMs = getTimeoutMs(tool.riskTier, config);
    const dispatchedCall = originalName === call.tool ? call : { ...call, tool: originalName };

    try {
      return await withTimeout(tool.execute(dispatchedCall), timeoutMs);
    } catch (error) {
      return createErrorResult(call, error instanceof Error ? error.message : String(error));
    }
  };
}
