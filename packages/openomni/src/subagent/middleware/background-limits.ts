import {
  MiddlewareEngine,
  type MiddlewareDecision,
  type MiddlewareRegistration,
} from "@openomni/agent";
import type { Hook, Middleware, Subagent, TraceContext } from "@openomni/protocol";
import { Log } from "@openomni/session";

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

interface LaunchRequest {
  readonly agentName: string;
  readonly prompt: string;
  readonly model: { readonly provider: string; readonly id: string };
  readonly parentSessionId: string;
  readonly depth?: number;
}

interface BackgroundLimitState {
  readonly input: LaunchRequest;
  readonly depth: number;
  readonly activeTasks: readonly Subagent.BackgroundTask[];
  readonly activeCount: number;
  readonly pendingQueueSize: number;
  readonly maxConcurrentPerAgent: number;
  readonly maxConcurrentTotal: number;
  readonly maxDepth: number;
  readonly maxDescendants: number;
  readonly maxQueueSize: number;
  shouldQueue?: boolean;
}

function continueVerdict(policyId: string, reason: string): Hook.Verdict {
  return { action: "continue", policyId, reason };
}

function abortVerdict(policyId: string, reason: string): Hook.Verdict {
  return { action: "abort", policyId, reason };
}

function createPerAgentLimit(state: BackgroundLimitState): MiddlewareRegistration {
  return {
    ...BackgroundLimitsMiddleware.PerAgent,
    failPolicy: "fail-closed",
    fn: () => {
      const count = state.activeTasks.filter((t) => t.agentName === state.input.agentName).length;
      if (count >= state.maxConcurrentPerAgent) {
        Log.warn("background.limit.per-agent", {
          agentName: state.input.agentName,
          count,
          limit: state.maxConcurrentPerAgent,
        });
        return abortVerdict(
          "background.limit.per-agent",
          `max concurrent tasks per agent (${state.maxConcurrentPerAgent}) exceeded`,
        );
      }

      return continueVerdict("background.limit.per-agent", "per-agent capacity available");
    },
  };
}

function createDepthLimit(state: BackgroundLimitState): MiddlewareRegistration {
  return {
    ...BackgroundLimitsMiddleware.Depth,
    failPolicy: "fail-closed",
    fn: () => {
      if (state.depth > state.maxDepth) {
        Log.warn("background.limit.depth", {
          agentName: state.input.agentName,
          depth: state.depth,
          limit: state.maxDepth,
        });
        return abortVerdict("background.limit.depth", `max depth (${state.maxDepth}) exceeded`);
      }

      return continueVerdict("background.limit.depth", "depth within limit");
    },
  };
}

function createDescendantLimit(state: BackgroundLimitState): MiddlewareRegistration {
  return {
    ...BackgroundLimitsMiddleware.Descendants,
    failPolicy: "fail-closed",
    fn: () => {
      const count = state.activeTasks.filter(
        (t) => t.parentSessionId === state.input.parentSessionId,
      ).length;
      if (count >= state.maxDescendants) {
        Log.warn("background.limit.descendants", {
          parentSessionId: state.input.parentSessionId,
          count,
          limit: state.maxDescendants,
        });
        return abortVerdict(
          "background.limit.descendants",
          `max descendants (${state.maxDescendants}) from same parent exceeded`,
        );
      }

      return continueVerdict("background.limit.descendants", "descendant capacity available");
    },
  };
}

function createTotalLimit(state: BackgroundLimitState): MiddlewareRegistration {
  return {
    ...BackgroundLimitsMiddleware.Total,
    failPolicy: "fail-closed",
    fn: () => {
      state.shouldQueue = state.activeCount >= state.maxConcurrentTotal;
      if (state.shouldQueue) {
        return continueVerdict(
          "background.limit.total",
          "total concurrency saturated; queue required",
        );
      }

      return continueVerdict("background.limit.total", "total concurrency capacity available");
    },
  };
}

function createQueueLimit(state: BackgroundLimitState): MiddlewareRegistration {
  return {
    ...BackgroundLimitsMiddleware.Queue,
    failPolicy: "fail-closed",
    fn: () => {
      if (!state.shouldQueue) {
        return continueVerdict("background.limit.queue", "queue capacity not required");
      }

      if (state.pendingQueueSize >= state.maxQueueSize) {
        Log.warn("background.limit.queue-full", {
          agentName: state.input.agentName,
          queueSize: state.pendingQueueSize,
          limit: state.maxQueueSize,
        });
        return abortVerdict("background.limit.queue", `queue full (max ${state.maxQueueSize})`);
      }

      return continueVerdict("background.limit.queue", "queue capacity available");
    },
  };
}

export namespace BackgroundLimitsMiddleware {
  export const PerAgent = {
    name: "background:per-agent-limit",
    timing: "pre_tool_use",
    priority: 0,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const Depth = {
    name: "background:depth-limit",
    timing: "pre_tool_use",
    priority: 10,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const Descendants = {
    name: "background:descendant-limit",
    timing: "pre_tool_use",
    priority: 20,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const Total = {
    name: "background:total-limit",
    timing: "pre_tool_use",
    priority: 30,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const Queue = {
    name: "background:queue-limit",
    timing: "pre_tool_use",
    priority: 40,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export interface PreLaunchContext {
    readonly input: LaunchRequest;
    readonly activeTasks: readonly Subagent.BackgroundTask[];
    readonly activeCount: number;
    readonly pendingQueueSize: number;
    readonly maxConcurrentPerAgent: number;
    readonly maxConcurrentTotal: number;
    readonly maxDepth: number;
    readonly maxDescendants: number;
    readonly maxQueueSize: number;
    readonly traceContext?: TraceContext.Type;
    readonly onDecision?: (decision: MiddlewareDecision) => void | Promise<void>;
  }

  export interface PreLaunchResult {
    readonly verdict: Hook.Verdict;
    readonly shouldQueue: boolean;
  }

  export function registrations(state: BackgroundLimitState): MiddlewareRegistration[] {
    return [
      createPerAgentLimit(state),
      createDepthLimit(state),
      createDescendantLimit(state),
      createTotalLimit(state),
      createQueueLimit(state),
    ];
  }

  export async function evaluatePreLaunch(ctx: PreLaunchContext): Promise<PreLaunchResult> {
    const state: BackgroundLimitState = {
      input: ctx.input,
      depth: ctx.input.depth ?? 0,
      activeTasks: ctx.activeTasks,
      activeCount: ctx.activeCount,
      pendingQueueSize: ctx.pendingQueueSize,
      maxConcurrentPerAgent: ctx.maxConcurrentPerAgent,
      maxConcurrentTotal: ctx.maxConcurrentTotal,
      maxDepth: ctx.maxDepth,
      maxDescendants: ctx.maxDescendants,
      maxQueueSize: ctx.maxQueueSize,
    };
    const engine = MiddlewareEngine.create({
      traceContext: ctx.traceContext,
      onDecision: ctx.onDecision,
      eventLog: false,
    });

    for (const registration of registrations(state)) {
      engine.register(registration);
    }

    const verdict = await engine.dispatch("pre_tool_use", {
      steps: [],
      usage: emptyUsage,
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolName: "subagent",
      toolInput: {
        operation: "background.launch",
        agentName: ctx.input.agentName,
        parentSessionId: ctx.input.parentSessionId,
        depth: ctx.input.depth ?? 0,
        activeCount: ctx.activeCount,
        pendingQueueSize: ctx.pendingQueueSize,
      },
      traceContext: ctx.traceContext,
    });

    return { verdict, shouldQueue: state.shouldQueue ?? false };
  }
}
