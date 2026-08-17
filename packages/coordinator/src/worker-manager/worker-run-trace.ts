import type { ActiveRun, DeliverTask, WorkerPorts, WorkerSlot } from "./worker-manager-types";

export type ActiveRunRegistry = Map<string, ActiveRun>;
export type TracedDeliverTask = DeliverTask & { readonly traceId: string };

/**
 * A deliver task carries the trace of the dispatch that produced it. Minting
 * one here gave the worker run its own trace, unlinked from the request — and
 * because it was minted upstream of every guard, no guard could see it.
 */
export function normalizeDeliverTaskTrace(task: DeliverTask): TracedDeliverTask {
  if (typeof task.traceId !== "string" || task.traceId.length === 0) {
    throw new Error("deliver task requires the dispatch traceId");
  }
  return task as TracedDeliverTask;
}

export function createActiveRun(runId: string, task: TracedDeliverTask): ActiveRun {
  return {
    runId,
    sessionId: task.sessionId,
    traceId: task.traceId,
    ...(typeof task.agentName === "string" ? { agentName: task.agentName } : {}),
  };
}

export function bindToolRelayTrace(
  toolRelay: WorkerPorts["toolRelay"],
  activeRuns: ReadonlyMap<string, ActiveRun>,
  slot: WorkerSlot,
): WorkerPorts["toolRelay"] {
  if (toolRelay === undefined) return undefined;

  return (params, context) => {
    const activeRun = activeRuns.get(params.runId);
    if (activeRun?.slot !== slot) {
      // TODO(#audit M5): a worker can relay a runId that is not its own slot's
      // run; today the call passes through WITHOUT a trace context (the relay
      // trust test pins this) instead of being rejected. Rejecting on slot
      // mismatch would be the safer contract — revisit when the relay policy
      // is owned end to end.
      return toolRelay(params, context);
    }
    return toolRelay(params, {
      ...context,
      traceContext: {
        traceId: activeRun.traceId,
        sessionId: activeRun.sessionId,
        runId: activeRun.runId,
        ...(activeRun.agentName !== undefined ? { agentName: activeRun.agentName } : {}),
      },
    });
  };
}
