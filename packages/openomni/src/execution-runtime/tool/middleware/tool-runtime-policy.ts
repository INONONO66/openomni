import {
  Operational,
  PolicyDecision,
  type Policy,
  type RuntimeResource,
  type TraceContext,
} from "@openomni/protocol";
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

function allowDecision(reason: string, effects: Policy.PolicyEffect[] = []): Policy.PolicyDecision {
  return PolicyDecision.allow({ policyId, reasonCodes: [reason], effects });
}

function abortDecision(reason: string): Policy.PolicyDecision {
  return PolicyDecision.deny({
    policyId,
    reasonCodes: [reason],
    effects: [{ type: "run.abort", reason }],
  });
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

function riskTierFromDescriptor(
  descriptor: RuntimeResource.Descriptor | undefined,
  fallback: ToolRiskTier,
): ToolRiskTier {
  return descriptor?.risk === 0 ||
    descriptor?.risk === 1 ||
    descriptor?.risk === 2 ||
    descriptor?.risk === 3
    ? descriptor.risk
    : fallback;
}

function recordDecision(
  decision: Policy.PolicyDecision,
  onDecision: ((decision: Policy.PolicyDecision) => void | Promise<void>) | undefined,
): void {
  void onDecision?.(decision);
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

  export interface TimeoutOptions {
    readonly onTimeout?: (error: TimeoutError) => void;
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
    readonly descriptor?: RuntimeResource.Descriptor;
    readonly timeoutConfig?: ToolExecutorConfig["timeoutMs"];
    readonly workspaceRoot?: string;
    readonly lockOwnerId: string;
    readonly signal?: AbortSignal;
    readonly traceContext?: TraceContext.Type;
    readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
  }

  export interface PreToolResult {
    readonly decision: Policy.PolicyDecision;
    readonly handle: RuntimePolicyHandle;
  }

  export interface PostToolContext {
    readonly toolName: string;
    readonly toolCallId?: string;
    readonly input: Record<string, unknown>;
    readonly output?: string;
    readonly handle: RuntimePolicyHandle;
    readonly traceContext?: TraceContext.Type;
    readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
  }

  export async function evaluatePreTool(ctx: PreToolContext): Promise<PreToolResult> {
    const riskTier = riskTierFromDescriptor(ctx.descriptor, ctx.riskTier);
    const timeoutMs = timeoutForRiskTier(riskTier, ctx.timeoutConfig);
    const handle: RuntimePolicyHandle = {
      timeoutMs,
      lockOwnerId: ctx.lockOwnerId,
      ...(ctx.workspaceRoot !== undefined && { workspaceRoot: ctx.workspaceRoot }),
      lockAcquired: false,
    };

    const riskDecision = allowDecision(
      riskTier >= 2 ? "high-risk tool execution recorded" : "risk tier evaluated",
    );
    Bus.publish(riskTier >= 2 ? Operational.Warn : Operational.Debug, {
      traceId: ctx.traceContext?.traceId ?? crypto.randomUUID(),
      time: Date.now(),
      component: "executor.policy",
      msg: riskTier >= 2 ? "executor: high-risk tool execution" : "executor: risk tier evaluated",
      context: { toolName: ctx.toolName, tier: riskTier, descriptorId: ctx.descriptor?.id },
    });
    recordDecision(riskDecision, ctx.onDecision);

    recordDecision(
      allowDecision("timeout resolved", [{ type: "runtime.set_timeout", timeoutMs }]),
      ctx.onDecision,
    );

    if (riskTier < 1 || !ctx.workspaceRoot) {
      recordDecision(allowDecision("workspace lock not required"), ctx.onDecision);
      return { decision: allowDecision("runtime policy evaluated"), handle };
    }

    try {
      await WorkspaceLock.acquire(ctx.workspaceRoot, ctx.lockOwnerId, 30_000, ctx.signal);
      handle.lockAcquired = true;
      recordDecision(
        allowDecision("workspace lock acquired", [
          { type: "runtime.workspace_lock", required: true },
        ]),
        ctx.onDecision,
      );
      return { decision: allowDecision("runtime policy evaluated"), handle };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      const decision = abortDecision(error instanceof Error ? error.message : String(error));
      recordDecision(decision, ctx.onDecision);
      return { decision, handle };
    }
  }

  export function evaluatePostTool(ctx: PostToolContext): Policy.PolicyDecision {
    if (!ctx.handle.lockAcquired || !ctx.handle.workspaceRoot) {
      recordDecision(allowDecision("workspace lock release not required"), ctx.onDecision);
      return allowDecision("runtime policy post-tool evaluated");
    }

    WorkspaceLock.release(ctx.handle.workspaceRoot, ctx.handle.lockOwnerId);
    ctx.handle.lockAcquired = false;
    recordDecision(allowDecision("workspace lock released"), ctx.onDecision);
    return allowDecision("runtime policy post-tool evaluated");
  }

  export function enforceTimeout<T>(
    promise: Promise<T>,
    ms: number,
    options: TimeoutOptions = {},
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        const timer = globalThis.setTimeout(() => {
          const error = new TimeoutError(ms);
          reject(error);
          try {
            options.onTimeout?.(error);
          } catch {
            // Timeout rejection is authoritative; do not let cleanup callbacks
            // escape the timer turn as uncaught exceptions.
          }
        }, ms);

        promise.then(
          () => globalThis.clearTimeout(timer),
          () => globalThis.clearTimeout(timer),
        );
      }),
    ]);
  }
}
