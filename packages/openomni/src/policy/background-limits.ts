import { PolicyEngine, type PolicyDecision, type PolicyRegistration } from "@openomni/agent";
import { Operational, type Policy, type Subagent, type TraceContext } from "@openomni/protocol";
import { Bus } from "@openomni/session";

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

function continueVerdict(policyId: string, reason: string): Policy.Verdict {
  return { action: "continue", policyId, reason };
}

function denyVerdict(reason: string): Policy.Verdict {
  return { action: "abort", reason };
}

function createPerAgentLimit(state: BackgroundLimitState): PolicyRegistration {
  return {
    ...BackgroundLimitsPolicy.PerAgent,
    failPolicy: "fail-closed",
    fn: () => {
      const count = state.activeTasks.filter((t) => t.agentName === state.input.agentName).length;
      if (count >= state.maxConcurrentPerAgent) {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "openomni.policy.background-limits",
          msg: "background.limit.per-agent",
          context: {
            agentName: state.input.agentName,
            count,
            limit: state.maxConcurrentPerAgent,
          },
        });
        return denyVerdict(
          `max concurrent tasks per agent (${state.maxConcurrentPerAgent}) exceeded`,
        );
      }

      return continueVerdict("background.per-agent-limit", "per-agent capacity available");
    },
  };
}

function createDepthLimit(state: BackgroundLimitState): PolicyRegistration {
  return {
    ...BackgroundLimitsPolicy.Depth,
    failPolicy: "fail-closed",
    fn: () => {
      if (state.depth > state.maxDepth) {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "openomni.policy.background-limits",
          msg: "background.limit.depth",
          context: {
            agentName: state.input.agentName,
            depth: state.depth,
            limit: state.maxDepth,
          },
        });
        return denyVerdict(`max depth (${state.maxDepth}) exceeded`);
      }

      return continueVerdict("background.depth-limit", "depth within limit");
    },
  };
}

function createDescendantLimit(state: BackgroundLimitState): PolicyRegistration {
  return {
    ...BackgroundLimitsPolicy.Descendants,
    failPolicy: "fail-closed",
    fn: () => {
      const count = state.activeTasks.filter(
        (t) => t.parentSessionId === state.input.parentSessionId,
      ).length;
      if (count >= state.maxDescendants) {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "openomni.policy.background-limits",
          msg: "background.limit.descendants",
          context: {
            parentSessionId: state.input.parentSessionId,
            count,
            limit: state.maxDescendants,
          },
        });
        return denyVerdict(`max descendants (${state.maxDescendants}) from same parent exceeded`);
      }

      return continueVerdict("background.descendant-limit", "descendant capacity available");
    },
  };
}

function createTotalLimit(state: BackgroundLimitState): PolicyRegistration {
  return {
    ...BackgroundLimitsPolicy.Total,
    failPolicy: "fail-closed",
    fn: () => {
      state.shouldQueue = state.activeCount >= state.maxConcurrentTotal;
      if (state.shouldQueue) {
        return continueVerdict(
          "background.total-limit",
          "total concurrency saturated; queue required",
        );
      }

      return continueVerdict("background.total-limit", "total concurrency capacity available");
    },
  };
}

function createQueueLimit(state: BackgroundLimitState): PolicyRegistration {
  return {
    ...BackgroundLimitsPolicy.Queue,
    failPolicy: "fail-closed",
    fn: () => {
      if (!state.shouldQueue) {
        return continueVerdict("background.limit.queue", "queue capacity not required");
      }

      if (state.pendingQueueSize >= state.maxQueueSize) {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "openomni.policy.background-limits",
          msg: "background.limit.queue-full",
          context: {
            agentName: state.input.agentName,
            queueSize: state.pendingQueueSize,
            limit: state.maxQueueSize,
          },
        });
        return denyVerdict(`queue full (max ${state.maxQueueSize})`);
      }

      return continueVerdict("background.queue-limit", "queue capacity available");
    },
  };
}

export namespace BackgroundLimitsPolicy {
  export const PerAgent = {
    name: "background:per-agent-limit",
    timing: "pre_tool_use",
    priority: 0,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const Depth = {
    name: "background:depth-limit",
    timing: "pre_tool_use",
    priority: 10,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const Descendants = {
    name: "background:descendant-limit",
    timing: "pre_tool_use",
    priority: 20,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const Total = {
    name: "background:total-limit",
    timing: "pre_tool_use",
    priority: 30,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const Queue = {
    name: "background:queue-limit",
    timing: "pre_tool_use",
    priority: 40,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

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
    readonly onDecision?: (decision: PolicyDecision) => void | Promise<void>;
  }

  export interface PreLaunchResult {
    readonly verdict: Policy.Verdict;
    readonly shouldQueue: boolean;
  }

  export function registrations(state: BackgroundLimitState): PolicyRegistration[] {
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
    const engine = PolicyEngine.create({
      traceContext: ctx.traceContext,
      onDecision: ctx.onDecision,
      audit: false,
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
