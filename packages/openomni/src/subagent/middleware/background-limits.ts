import { PolicyEngine, type PolicyRegistration } from "@openomni/agent";
import {
  Operational,
  Policy,
  PolicyDecision,
  type RuntimeResource,
  type Subagent,
  type TraceContext,
} from "@openomni/protocol";
import { Bus } from "@openomni/session";

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

type BackgroundPolicyContext = Parameters<ReturnType<typeof PolicyEngine.create>["dispatch"]>[1] & {
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
};

function createBackgroundLaunchDescriptor(agentName: string): RuntimeResource.Descriptor {
  return {
    id: "worker:agent:background_launch",
    kind: "worker",
    source: { type: "agent", agentId: agentName },
    labels: ["source.agent", "delegation.background"],
    capabilities: ["delegation.background"],
    effects: ["session.create"],
  };
}

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

interface PreLaunchContext {
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
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
  readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
}

interface PreLaunchResult {
  readonly verdict: Policy.PolicyDecision;
  readonly shouldQueue: boolean;
}

function allowDecision(policyId: string, reason: string): Policy.PolicyDecision {
  return PolicyDecision.allow({ policyId, reasonCodes: [reason] });
}

function evaluateLimit(input: {
  readonly action: string;
  readonly resource: string;
  readonly field: string;
  readonly allowed: boolean;
  readonly allowReason: string;
  readonly denyReason: string;
  readonly metadata?: Record<string, unknown>;
}): Policy.PolicyDecision {
  return PolicyDecision.fromEvaluation(
    Policy.evaluate(
      {
        action: input.action,
        inputRules: [
          {
            toolPattern: input.resource,
            field: input.field,
            pattern: "^true$",
            action: "allow",
            reason: input.allowReason,
            priority: 2,
          },
          {
            toolPattern: input.resource,
            field: input.field,
            pattern: "^false$",
            action: "deny",
            reason: input.denyReason,
            priority: 1,
          },
        ],
      },
      {
        action: input.action,
        resource: input.resource,
        input: { [input.field]: String(input.allowed) },
        metadata: input.metadata,
      },
    ),
    { denyEffect: { type: "run.abort", reason: input.denyReason } },
  );
}

function createPerAgentLimit(state: BackgroundLimitState): PolicyRegistration {
  return {
    ...BackgroundLimitsMiddleware.PerAgent,
    failPolicy: "fail-closed",
    fn: () => {
      const count = state.activeTasks.filter((t) => t.agentName === state.input.agentName).length;
      if (count >= state.maxConcurrentPerAgent) {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "subagent.background-limits",
          msg: "background.limit.per-agent",
          context: {
            agentName: state.input.agentName,
            count,
            limit: state.maxConcurrentPerAgent,
          },
        });
        return evaluateLimit({
          action: "background.launch",
          resource: `agent.${state.input.agentName}`,
          field: "withinPerAgentLimit",
          allowed: false,
          allowReason: "per-agent capacity available",
          denyReason: `max concurrent tasks per agent (${state.maxConcurrentPerAgent}) exceeded`,
          metadata: { count, limit: state.maxConcurrentPerAgent },
        });
      }

      return evaluateLimit({
        action: "background.launch",
        resource: `agent.${state.input.agentName}`,
        field: "withinPerAgentLimit",
        allowed: true,
        allowReason: "per-agent capacity available",
        denyReason: `max concurrent tasks per agent (${state.maxConcurrentPerAgent}) exceeded`,
      });
    },
  };
}

function createDepthLimit(state: BackgroundLimitState): PolicyRegistration {
  return {
    ...BackgroundLimitsMiddleware.Depth,
    failPolicy: "fail-closed",
    fn: () => {
      if (state.depth > state.maxDepth) {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "subagent.background-limits",
          msg: "background.limit.depth",
          context: {
            agentName: state.input.agentName,
            depth: state.depth,
            limit: state.maxDepth,
          },
        });
        return evaluateLimit({
          action: "background.launch",
          resource: `session.${state.input.parentSessionId}`,
          field: "withinDepthLimit",
          allowed: false,
          allowReason: "depth within limit",
          denyReason: `max depth (${state.maxDepth}) exceeded`,
          metadata: { depth: state.depth, limit: state.maxDepth },
        });
      }

      return evaluateLimit({
        action: "background.launch",
        resource: `session.${state.input.parentSessionId}`,
        field: "withinDepthLimit",
        allowed: true,
        allowReason: "depth within limit",
        denyReason: `max depth (${state.maxDepth}) exceeded`,
      });
    },
  };
}

function createDescendantLimit(state: BackgroundLimitState): PolicyRegistration {
  return {
    ...BackgroundLimitsMiddleware.Descendants,
    failPolicy: "fail-closed",
    fn: () => {
      const count = state.activeTasks.filter(
        (t) => t.parentSessionId === state.input.parentSessionId,
      ).length;
      if (count >= state.maxDescendants) {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "subagent.background-limits",
          msg: "background.limit.descendants",
          context: {
            parentSessionId: state.input.parentSessionId,
            count,
            limit: state.maxDescendants,
          },
        });
        return evaluateLimit({
          action: "background.launch",
          resource: `session.${state.input.parentSessionId}`,
          field: "withinDescendantLimit",
          allowed: false,
          allowReason: "descendant capacity available",
          denyReason: `max descendants (${state.maxDescendants}) from same parent exceeded`,
          metadata: { count, limit: state.maxDescendants },
        });
      }

      return evaluateLimit({
        action: "background.launch",
        resource: `session.${state.input.parentSessionId}`,
        field: "withinDescendantLimit",
        allowed: true,
        allowReason: "descendant capacity available",
        denyReason: `max descendants (${state.maxDescendants}) from same parent exceeded`,
      });
    },
  };
}

function createTotalLimit(state: BackgroundLimitState): PolicyRegistration {
  return {
    ...BackgroundLimitsMiddleware.Total,
    failPolicy: "fail-closed",
    fn: () => {
      state.shouldQueue = state.activeCount >= state.maxConcurrentTotal;
      if (state.shouldQueue) {
        return evaluateLimit({
          action: "background.launch",
          resource: "background.total",
          field: "withinTotalLimit",
          allowed: true,
          allowReason: "total concurrency saturated; queue required",
          denyReason: "total concurrency exceeded",
          metadata: { activeCount: state.activeCount, limit: state.maxConcurrentTotal },
        });
      }

      return evaluateLimit({
        action: "background.launch",
        resource: "background.total",
        field: "withinTotalLimit",
        allowed: true,
        allowReason: "total concurrency capacity available",
        denyReason: "total concurrency exceeded",
      });
    },
  };
}

function createQueueLimit(state: BackgroundLimitState): PolicyRegistration {
  return {
    ...BackgroundLimitsMiddleware.Queue,
    failPolicy: "fail-closed",
    fn: () => {
      if (!state.shouldQueue) {
        return allowDecision("background.limit.queue", "queue capacity not required");
      }

      if (state.pendingQueueSize >= state.maxQueueSize) {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "subagent.background-limits",
          msg: "background.limit.queue-full",
          context: {
            agentName: state.input.agentName,
            queueSize: state.pendingQueueSize,
            limit: state.maxQueueSize,
          },
        });
        return evaluateLimit({
          action: "background.launch",
          resource: "background.queue",
          field: "withinQueueLimit",
          allowed: false,
          allowReason: "queue capacity available",
          denyReason: `queue full (max ${state.maxQueueSize})`,
          metadata: { queueSize: state.pendingQueueSize, limit: state.maxQueueSize },
        });
      }

      return evaluateLimit({
        action: "background.launch",
        resource: "background.queue",
        field: "withinQueueLimit",
        allowed: true,
        allowReason: "queue capacity available",
        denyReason: `queue full (max ${state.maxQueueSize})`,
      });
    },
  };
}

export namespace BackgroundLimitsMiddleware {
  export const PerAgent = {
    name: "background:per-agent-limit",
    timing: "invoke.prepare",
    priority: 0,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const Depth = {
    name: "background:depth-limit",
    timing: "invoke.prepare",
    priority: 10,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const Descendants = {
    name: "background:descendant-limit",
    timing: "invoke.prepare",
    priority: 20,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const Total = {
    name: "background:total-limit",
    timing: "invoke.prepare",
    priority: 30,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const Queue = {
    name: "background:queue-limit",
    timing: "invoke.prepare",
    priority: 40,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

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
    const traceContext = ctx.traceContext ?? {
      traceId: crypto.randomUUID(),
      sessionId: ctx.input.parentSessionId,
    };
    const resourceDescriptor =
      ctx.resourceDescriptor ?? createBackgroundLaunchDescriptor(ctx.input.agentName);
    const engine = PolicyEngine.create({
      traceContext,
      onDecision: ctx.onDecision,
      audit: {
        sessionId: traceContext.sessionId,
        action: "delegation.background.launch",
        resource: `agent.${ctx.input.agentName}`,
      },
    });

    for (const registration of registrations(state)) {
      engine.register(registration);
    }

    const policyContext: BackgroundPolicyContext = {
      steps: [],
      usage: emptyUsage,
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolName: "subagent",
      toolLabels: resourceDescriptor.labels,
      toolInput: {
        operation: "background.launch",
        agentName: ctx.input.agentName,
        parentSessionId: ctx.input.parentSessionId,
        depth: ctx.input.depth ?? 0,
        activeCount: ctx.activeCount,
        pendingQueueSize: ctx.pendingQueueSize,
      },
      traceContext,
      resourceDescriptor,
    };

    const verdict = await engine.dispatch("invoke.prepare", policyContext);

    return { verdict, shouldQueue: state.shouldQueue ?? false };
  }
}
