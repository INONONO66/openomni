import type { ActiveRun, DeliverTask, WorkerPorts, WorkerSlot } from "./worker-manager-types";

export type ActiveRunRegistry = Map<string, ActiveRun>;

export function createActiveRun(runId: string, task: DeliverTask): ActiveRun {
  return {
    runId,
    sessionId: task.sessionId,
    ...(typeof task.traceId === "string" ? { traceId: task.traceId } : {}),
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
    if (activeRun?.slot !== slot || activeRun.traceId === undefined) {
      return toolRelay(params, context);
    }
    return toolRelay(params, {
      ...context,
      traceContext: {
        traceId: activeRun.traceId,
        sessionId: activeRun.sessionId,
        runId: activeRun.runId,
      },
    });
  };
}
