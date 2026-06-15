import { PolicyDecision, type Policy, type RuntimeResource, Subagent } from "@openomni/protocol";
import { Bus } from "@openomni/session";

export function createBackgroundLaunchDescriptor(agentName: string): RuntimeResource.Descriptor {
  return {
    id: "worker:agent:background_launch",
    kind: "worker",
    source: { type: "agent", agentId: agentName },
    labels: ["source.agent", "delegation.background"],
    capabilities: ["delegation.background"],
    effects: ["session.create"],
  };
}

export function backgroundLaunchFailureReason(decision: Policy.PolicyDecision): string | undefined {
  if (!PolicyDecision.isBlocking(decision)) return undefined;
  return PolicyDecision.reason(decision, `background launch policy returned ${decision.verdict}`);
}

export function publishBackgroundTaskLaunched(input: {
  readonly taskId: string;
  readonly agentName: string;
  readonly parentSessionId: string;
}): void {
  Bus.publish(Subagent.Events.BackgroundTaskLaunched, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    payload: {
      taskId: input.taskId,
      agentName: input.agentName,
      parentSessionId: input.parentSessionId,
      status: "running",
    },
  });
}

export function publishBackgroundTaskCompleted(input: {
  readonly taskId: string;
  readonly sessionId: string;
}): void {
  Bus.publish(Subagent.Events.BackgroundTaskCompleted, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    payload: { taskId: input.taskId, status: "completed", sessionId: input.sessionId },
  });
}

export function publishBackgroundTaskFailed(input: {
  readonly taskId: string;
  readonly error: string | undefined;
}): void {
  Bus.publish(Subagent.Events.BackgroundTaskFailed, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    payload: { taskId: input.taskId, error: input.error },
  });
}

export function publishBackgroundTaskCancelled(taskId: string): void {
  Bus.publish(Subagent.Events.BackgroundTaskCancelled, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    payload: { taskId },
  });
}
