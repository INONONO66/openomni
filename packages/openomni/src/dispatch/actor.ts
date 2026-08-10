import { type Actor, Dispatch } from "@openomni/protocol";
import { WorkItemAttemptRun } from "@openomni/session";

export interface DispatchRuntimeContext {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agentName?: string;
  readonly workspaceRoot?: string;
  readonly traceId?: string;
  readonly actorKind?: Dispatch.ActorKind;
  readonly actorId?: string;
  readonly trustTier?: Actor.TrustTier;
  readonly labels?: readonly string[];
}

function actorKindFromAgent(agentName: string | undefined): Dispatch.ActorKind {
  if (!agentName) return "unknown";
  const normalized = agentName.trim().toLowerCase();
  if (normalized === "resident") return "resident";
  if (normalized === "system" || normalized === "scheduler") return "system";
  return "worker";
}

// #510 D2b — run existence derives from WorkItem attempt facts; frozen
// legacy worker_run_state rows keep answering through the upcast view.
function lookupWorkerRun(sessionId: string | undefined, runId: string | undefined) {
  if (!sessionId || !runId) return undefined;
  try {
    return WorkItemAttemptRun.find(sessionId, runId);
  } catch {
    return undefined;
  }
}

function deriveTrustTier(
  context: DispatchRuntimeContext,
  hasWorkerRun: boolean,
): Actor.TrustTier | undefined {
  if (context.trustTier) return context.trustTier;
  return hasWorkerRun ? "assigned_worker" : undefined;
}

export function deriveActorContext(context: DispatchRuntimeContext = {}): Dispatch.ActorContext {
  const workerRun = lookupWorkerRun(context.sessionId, context.runId);
  const kind = context.actorKind ?? (workerRun ? "worker" : actorKindFromAgent(context.agentName));
  const trustTier = deriveTrustTier(context, Boolean(workerRun));
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
    ...(trustTier ? { trustTier } : {}),
    labels: [...(context.labels ?? []), `actor.${kind}`],
    ...(kind === "unknown" ? { reason: "missing dispatch actor context" } : {}),
  });
}
