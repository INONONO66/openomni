import type { PolicyRegistration } from "@openomni/agent";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import * as Definitions from "./background-limit-definitions.js";
import { allowDecision, evaluateLimit } from "./background-limit-decisions.js";
import type { BackgroundLimitState } from "./background-limit-types.js";

function createPerAgentLimit(state: BackgroundLimitState): PolicyRegistration {
  return {
    ...Definitions.PerAgent,
    failPolicy: "fail-closed",
    fn: () => {
      const count = state.activeTasks.filter(
        (task) => task.agentName === state.input.agentName,
      ).length;
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
    ...Definitions.Depth,
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
    ...Definitions.Descendants,
    failPolicy: "fail-closed",
    fn: () => {
      const count = state.activeTasks.filter(
        (task) => task.parentSessionId === state.input.parentSessionId,
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
    ...Definitions.Total,
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
    ...Definitions.Queue,
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

export function createBackgroundLimitRegistrations(
  state: BackgroundLimitState,
): PolicyRegistration[] {
  return [
    createPerAgentLimit(state),
    createDepthLimit(state),
    createDescendantLimit(state),
    createTotalLimit(state),
    createQueueLimit(state),
  ];
}
