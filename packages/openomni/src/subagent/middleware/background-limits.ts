import { PolicyEngine, type PolicyRegistration } from "@openomni/agent";
import type { Policy } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import * as Definitions from "./background-limit-definitions.js";
import { createBackgroundLaunchDescriptor, emptyUsage } from "./background-limit-decisions.js";
import { createBackgroundLimitRegistrations } from "./background-limit-registrations.js";
import type {
  BackgroundLimitState,
  BackgroundPolicyContext,
  PreLaunchContext,
  PreLaunchResult,
} from "./background-limit-types.js";

export namespace BackgroundLimitsMiddleware {
  export const PerAgent = Definitions.PerAgent;
  export const Depth = Definitions.Depth;
  export const Descendants = Definitions.Descendants;
  export const Total = Definitions.Total;
  export const Queue = Definitions.Queue;

  export function registrations(state: BackgroundLimitState): PolicyRegistration[] {
    return createBackgroundLimitRegistrations(state);
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
      auditEmit: Bus.publish,
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

    const verdict: Policy.PolicyDecision = await engine.dispatch("invoke.prepare", policyContext);

    return { verdict, shouldQueue: state.shouldQueue ?? false };
  }
}
