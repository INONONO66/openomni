import type { ActiveRun, DeliverTask, WorkerPorts, WorkerSlot } from "./worker-manager-types";

export type ActiveRunRegistry = Map<string, ActiveRun>;
export type TracedDeliverTask = DeliverTask & { readonly traceId: string };

export function normalizeDeliverTaskTrace(task: DeliverTask): TracedDeliverTask {
  return typeof task.traceId === "string"
    ? (task as TracedDeliverTask)
    : { ...task, traceId: crypto.randomUUID() };
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
