import { Dispatch } from "@openomni/protocol";
import { WorkerRunStateStore } from "@openomni/session";

export interface DispatchRuntimeContext {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agentName?: string;
  readonly workspaceRoot?: string;
  readonly traceId?: string;
  readonly actorKind?: Dispatch.ActorKind;
  readonly actorId?: string;
  readonly trustTier?: string;
  readonly labels?: readonly string[];
}

function actorKindFromAgent(agentName: string | undefined): Dispatch.ActorKind {
  if (!agentName) return "unknown";
  const normalized = agentName.trim().toLowerCase();
  if (normalized === "resident") return "resident";
  if (normalized === "system" || normalized === "scheduler") return "system";
  return "worker";
}

function lookupWorkerRun(sessionId: string | undefined, runId: string | undefined) {
  if (!sessionId || !runId) return undefined;
  try {
    return WorkerRunStateStore.get(sessionId, runId);
  } catch {
    return undefined;
  }
}

export function deriveActorContext(context: DispatchRuntimeContext = {}): Dispatch.ActorContext {
  const workerRun = lookupWorkerRun(context.sessionId, context.runId);
  const kind = context.actorKind ?? (workerRun ? "worker" : actorKindFromAgent(context.agentName));
  const actorId =
    context.actorId ??
    (context.sessionId && context.runId
      ? `${context.sessionId}:${context.runId}`
      : context.agentName
        ? `agent:${context.agentName}`
        : "unknown");

  return Dispatch.ActorContext.parse({
    kind,
    actorId,
    ...(context.agentName ? { agentName: context.agentName } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.runId && kind === "worker" ? { workerRunId: context.runId } : {}),
    ...(context.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
    trustTier:
      context.trustTier ?? (workerRun ? "assigned_worker" : kind === "unknown" ? "unknown" : kind),
    labels: [...(context.labels ?? []), `actor.${kind}`],
    ...(kind === "unknown" ? { reason: "missing runtime actor context" } : {}),
  });
}
