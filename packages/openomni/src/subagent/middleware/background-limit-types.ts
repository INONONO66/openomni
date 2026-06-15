import type { Policy, RuntimeResource, Subagent, TraceContext } from "@openomni/protocol";

export type BackgroundPolicyContext = Parameters<
  ReturnType<typeof import("@openomni/agent").PolicyEngine.create>["dispatch"]
>[1] & {
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
};

interface LaunchRequest {
  readonly agentName: string;
  readonly prompt: string;
  readonly model: { readonly provider: string; readonly id: string };
  readonly parentSessionId: string;
  readonly depth?: number;
}

export interface BackgroundLimitState {
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
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
  readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
}

export interface PreLaunchResult {
  readonly verdict: Policy.PolicyDecision;
  readonly shouldQueue: boolean;
}
