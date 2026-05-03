import {
  MiddlewareEngine,
  type MiddlewareDecision,
  type MiddlewareRegistration,
} from "@openomni/agent";
import type { Hook, Middleware, TraceContext } from "@openomni/protocol";
import { Log } from "@openomni/session";
import { WorkspaceLock } from "../../workspace-lock.js";
import type { ToolExecutorConfig, ToolRiskTier } from "../types.js";

const policyId = "tool.runtime-policy";
const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const tierTimeouts: Record<number, number> = {
  0: 30_000,
  1: 30_000,
  2: 60_000,
  3: 120_000,
};
const defaultTierTimeoutMs = 30_000;

interface ToolRuntimePolicyState {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly input: Record<string, unknown>;
  readonly riskTier: ToolRiskTier;
  readonly timeoutConfig?: ToolExecutorConfig["timeoutMs"];
  readonly workspaceRoot?: string;
  readonly lockOwnerId: string;
  timeoutMs?: number;
  lockAcquired: boolean;
}

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

function completeDispatchVerdict(verdict: Hook.Verdict, reason: string): Hook.Verdict {
  if (verdict.action === "continue") {
    return {
      action: "continue",
      policyId: verdict.policyId ?? policyId,
      reason: verdict.reason ?? reason,
    };
  }

  if (verdict.action === "abort") {
    return {
      action: "abort",
      policyId: verdict.policyId ?? policyId,
      reason: verdict.reason ?? reason,
    };
  }

  return verdict;
}

function createRiskTierEvaluation(state: ToolRuntimePolicyState): MiddlewareRegistration {
  return {
    ...ToolRuntimePolicyMiddleware.RiskTier,
    failPolicy: "fail-closed",
    fn: () => {
      if (state.riskTier >= 2) {
        Log.warn("executor: high-risk tool execution", {
          toolName: state.toolName,
          tier: state.riskTier,
        });
        return continueVerdict("high-risk tool execution recorded");
      }

      Log.debug("executor: risk tier evaluated", {
        toolName: state.toolName,
        tier: state.riskTier,
      });
      return continueVerdict("risk tier evaluated");
    },
  };
}

function createTimeoutResolution(state: ToolRuntimePolicyState): MiddlewareRegistration {
  return {
    ...ToolRuntimePolicyMiddleware.Timeout,
    failPolicy: "fail-closed",
    fn: () => {
      state.timeoutMs = timeoutForRiskTier(state.riskTier, state.timeoutConfig);
      return continueVerdict("timeout resolved");
    },
  };
}

function createWorkspaceLockAcquire(state: ToolRuntimePolicyState): MiddlewareRegistration {
  return {
    ...ToolRuntimePolicyMiddleware.WorkspaceLockAcquire,
    failPolicy: "fail-closed",
    async fn() {
      if (state.riskTier < 1 || !state.workspaceRoot) {
        return continueVerdict("workspace lock not required");
      }

      try {
        await WorkspaceLock.acquire(state.workspaceRoot, state.lockOwnerId);
        state.lockAcquired = true;
        return continueVerdict("workspace lock acquired");
      } catch (error) {
        return abortVerdict(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function createWorkspaceLockRelease(state: ToolRuntimePolicyState): MiddlewareRegistration {
  return {
    ...ToolRuntimePolicyMiddleware.WorkspaceLockRelease,
    failPolicy: "fail-closed",
    fn: () => {
      if (!state.lockAcquired || !state.workspaceRoot) {
        return continueVerdict("workspace lock release not required");
      }

      WorkspaceLock.release(state.workspaceRoot, state.lockOwnerId);
      state.lockAcquired = false;
      return continueVerdict("workspace lock released");
    },
  };
}

export namespace ToolRuntimePolicyMiddleware {
  export const RiskTier = {
    name: "tool-runtime-policy:risk-tier",
    timing: "pre_tool_use",
    priority: 0,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const Timeout = {
    name: "tool-runtime-policy:timeout",
    timing: "pre_tool_use",
    priority: 10,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const WorkspaceLockAcquire = {
    name: "tool-runtime-policy:workspace-lock-acquire",
    timing: "pre_tool_use",
    priority: 20,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const WorkspaceLockRelease = {
    name: "tool-runtime-policy:workspace-lock-release",
    timing: "post_tool_use",
    priority: 0,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

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
    readonly onDecision?: (decision: MiddlewareDecision) => void | Promise<void>;
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
    readonly onDecision?: (decision: MiddlewareDecision) => void | Promise<void>;
  }

  export function registrations(state: ToolRuntimePolicyState): MiddlewareRegistration[] {
    return [
      createRiskTierEvaluation(state),
      createTimeoutResolution(state),
      createWorkspaceLockAcquire(state),
      createWorkspaceLockRelease(state),
    ];
  }

  export async function evaluatePreTool(ctx: PreToolContext): Promise<PreToolResult> {
    const state: ToolRuntimePolicyState = {
      toolName: ctx.toolName,
      ...(ctx.toolCallId !== undefined && { toolCallId: ctx.toolCallId }),
      input: ctx.input,
      riskTier: ctx.riskTier,
      ...(ctx.timeoutConfig !== undefined && { timeoutConfig: ctx.timeoutConfig }),
      ...(ctx.workspaceRoot !== undefined && { workspaceRoot: ctx.workspaceRoot }),
      lockOwnerId: ctx.lockOwnerId,
      lockAcquired: false,
    };
    const engine = MiddlewareEngine.create({
      traceContext: ctx.traceContext,
      onDecision: ctx.onDecision,
      eventLog: false,
    });

    for (const registration of registrations(state)) {
      if (registration.timing === "pre_tool_use") engine.register(registration);
    }

    const verdict = await engine.dispatch("pre_tool_use", {
      steps: [],
      usage: emptyUsage,
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolName: ctx.toolName,
      toolCallId: ctx.toolCallId,
      toolInput: ctx.input,
      traceContext: ctx.traceContext,
    });

    return {
      verdict: completeDispatchVerdict(verdict, "runtime policy evaluated"),
      handle: {
        timeoutMs: state.timeoutMs ?? timeoutForRiskTier(ctx.riskTier, ctx.timeoutConfig),
        lockOwnerId: state.lockOwnerId,
        ...(state.workspaceRoot !== undefined && { workspaceRoot: state.workspaceRoot }),
        lockAcquired: state.lockAcquired,
      },
    };
  }

  export async function evaluatePostTool(ctx: PostToolContext): Promise<Hook.Verdict> {
    const state: ToolRuntimePolicyState = {
      toolName: ctx.toolName,
      ...(ctx.toolCallId !== undefined && { toolCallId: ctx.toolCallId }),
      input: ctx.input,
      riskTier: 0,
      ...(ctx.handle.workspaceRoot !== undefined && { workspaceRoot: ctx.handle.workspaceRoot }),
      lockOwnerId: ctx.handle.lockOwnerId,
      timeoutMs: ctx.handle.timeoutMs,
      lockAcquired: ctx.handle.lockAcquired,
    };
    const engine = MiddlewareEngine.create({
      traceContext: ctx.traceContext,
      onDecision: ctx.onDecision,
      eventLog: false,
    });
    engine.register(createWorkspaceLockRelease(state));

    const verdict = await engine.dispatch("post_tool_use", {
      steps: [],
      usage: emptyUsage,
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolName: ctx.toolName,
      toolCallId: ctx.toolCallId,
      toolInput: ctx.input,
      toolOutput: ctx.output,
      traceContext: ctx.traceContext,
    });

    ctx.handle.lockAcquired = state.lockAcquired;
    return completeDispatchVerdict(verdict, "runtime policy post-tool evaluated");
  }

  export function enforceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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
}
