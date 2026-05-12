import type { PolicyDecision } from "@openomni/agent";
import type { Hook, TraceContext } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { WorkspaceLock } from "../../workspace-lock.js";
import type { ToolExecutorConfig, ToolRiskTier } from "../types.js";

const policyId = "tool.runtime-policy";
const tierTimeouts: Record<number, number> = {
  0: 30_000,
  1: 30_000,
  2: 60_000,
  3: 120_000,
};
const defaultTierTimeoutMs = 30_000;

function continueVerdict(reason: string): Hook.Verdict {
  return { action: "continue", policyId, reason };
}

function abortVerdict(reason: string): Hook.Verdict {
  return { action: "abort", policyId, reason };
}

function timeoutForRiskTier(
  riskTier: ToolRiskTier,
  config: ToolExecutorConfig["timeoutMs"] | undefined,
): number {
  const configured =
    riskTier === 0
      ? config?.tier0
      : riskTier === 1
        ? config?.tier1
        : riskTier === 2
          ? config?.tier2
          : undefined;

  return configured ?? tierTimeouts[riskTier] ?? defaultTierTimeoutMs;
}

function recordDecision(
  timing: "pre_tool_use" | "post_tool_use",
  name: string,
  verdict: Hook.Verdict,
  traceContext: TraceContext.Type | undefined,
  onDecision: ((decision: PolicyDecision) => void | Promise<void>) | undefined,
): void {
  void onDecision?.({
    timing,
    name,
    policyId: verdict.policyId ?? policyId,
    verdict: verdict.action,
    durationMs: 0,
    ...(verdict.reason !== undefined && { reason: verdict.reason }),
    ...(traceContext !== undefined && { traceContext }),
  });
}

export namespace ToolRuntimePolicyMiddleware {
  export class TimeoutError extends Error {
    readonly timeoutMs: number;

    constructor(timeoutMs: number) {
      super(`timeout after ${timeoutMs}ms`);
      this.name = "TimeoutError";
      this.timeoutMs = timeoutMs;
    }
  }

  export interface RuntimePolicyHandle {
    readonly timeoutMs: number;
    readonly lockOwnerId: string;
    readonly workspaceRoot?: string;
    lockAcquired: boolean;
  }

  export interface PreToolContext {
    readonly toolName: string;
    readonly toolCallId?: string;
    readonly input: Record<string, unknown>;
    readonly riskTier: ToolRiskTier;
    readonly timeoutConfig?: ToolExecutorConfig["timeoutMs"];
    readonly workspaceRoot?: string;
    readonly lockOwnerId: string;
    readonly traceContext?: TraceContext.Type;
    readonly onDecision?: (decision: PolicyDecision) => void | Promise<void>;
  }

  export interface PreToolResult {
    readonly verdict: Hook.Verdict;
    readonly handle: RuntimePolicyHandle;
  }

  export interface PostToolContext {
    readonly toolName: string;
    readonly toolCallId?: string;
    readonly input: Record<string, unknown>;
    readonly output?: string;
    readonly handle: RuntimePolicyHandle;
    readonly traceContext?: TraceContext.Type;
    readonly onDecision?: (decision: PolicyDecision) => void | Promise<void>;
  }

  export async function evaluatePreTool(ctx: PreToolContext): Promise<PreToolResult> {
    const timeoutMs = timeoutForRiskTier(ctx.riskTier, ctx.timeoutConfig);
    const handle: RuntimePolicyHandle = {
      timeoutMs,
      lockOwnerId: ctx.lockOwnerId,
      ...(ctx.workspaceRoot !== undefined && { workspaceRoot: ctx.workspaceRoot }),
      lockAcquired: false,
    };

    const riskVerdict = continueVerdict(
      ctx.riskTier >= 2 ? "high-risk tool execution recorded" : "risk tier evaluated",
    );
    Bus.publish(ctx.riskTier >= 2 ? Operational.Warn : Operational.Debug, {
      traceId: ctx.traceContext?.traceId ?? crypto.randomUUID(),
      time: Date.now(),
      component: "executor.policy",
      msg:
        ctx.riskTier >= 2 ? "executor: high-risk tool execution" : "executor: risk tier evaluated",
      context: { toolName: ctx.toolName, tier: ctx.riskTier },
    });
    recordDecision(
      "pre_tool_use",
      "tool-runtime-policy:risk-tier",
      riskVerdict,
      ctx.traceContext,
      ctx.onDecision,
    );

    const timeoutVerdict = continueVerdict("timeout resolved");
    recordDecision(
      "pre_tool_use",
      "tool-runtime-policy:timeout",
      timeoutVerdict,
      ctx.traceContext,
      ctx.onDecision,
    );

    if (ctx.riskTier < 1 || !ctx.workspaceRoot) {
      const verdict = continueVerdict("workspace lock not required");
      recordDecision(
        "pre_tool_use",
        "tool-runtime-policy:workspace-lock-acquire",
        verdict,
        ctx.traceContext,
        ctx.onDecision,
      );
      return { verdict: continueVerdict("runtime policy evaluated"), handle };
    }

    try {
      await WorkspaceLock.acquire(ctx.workspaceRoot, ctx.lockOwnerId);
      handle.lockAcquired = true;
      const verdict = continueVerdict("workspace lock acquired");
      recordDecision(
        "pre_tool_use",
        "tool-runtime-policy:workspace-lock-acquire",
        verdict,
        ctx.traceContext,
        ctx.onDecision,
      );
      return { verdict: continueVerdict("runtime policy evaluated"), handle };
    } catch (error) {
      const verdict = abortVerdict(error instanceof Error ? error.message : String(error));
      recordDecision(
        "pre_tool_use",
        "tool-runtime-policy:workspace-lock-acquire",
        verdict,
        ctx.traceContext,
        ctx.onDecision,
      );
      return { verdict, handle };
    }
  }

  export function evaluatePostTool(ctx: PostToolContext): Hook.Verdict {
    if (!ctx.handle.lockAcquired || !ctx.handle.workspaceRoot) {
      const verdict = continueVerdict("workspace lock release not required");
      recordDecision(
        "post_tool_use",
        "tool-runtime-policy:workspace-lock-release",
        verdict,
        ctx.traceContext,
        ctx.onDecision,
      );
      return continueVerdict("runtime policy post-tool evaluated");
    }

    WorkspaceLock.release(ctx.handle.workspaceRoot, ctx.handle.lockOwnerId);
    ctx.handle.lockAcquired = false;
    const verdict = continueVerdict("workspace lock released");
    recordDecision(
      "post_tool_use",
      "tool-runtime-policy:workspace-lock-release",
      verdict,
      ctx.traceContext,
      ctx.onDecision,
    );
    return continueVerdict("runtime policy post-tool evaluated");
  }

  export function enforceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        const timer = globalThis.setTimeout(() => {
          reject(new TimeoutError(ms));
        }, ms);

        promise.then(
          () => globalThis.clearTimeout(timer),
          () => globalThis.clearTimeout(timer),
        );
      }),
    ]);
  }
}
