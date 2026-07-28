import { type Actor, Dispatch } from "@openomni/protocol";

export interface DispatchRuntimeContext {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly attempt?: {
    readonly workItemId: string;
    readonly attemptId: string;
    readonly attemptSeq: number;
  };
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

function deriveTrustTier(context: DispatchRuntimeContext): Actor.TrustTier | undefined {
  if (context.trustTier) return context.trustTier;
  return context.attempt ? "assigned_worker" : undefined;
}

export function deriveActorContext(context: DispatchRuntimeContext = {}): Dispatch.ActorContext {
  const kind = context.actorKind ?? actorKindFromAgent(context.agentName);
  const trustTier = deriveTrustTier(context);
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
    ...(context.attempt && kind === "worker" ? { workerRunId: context.attempt.attemptId } : {}),
    ...(context.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
    ...(trustTier ? { trustTier } : {}),
    labels: [...(context.labels ?? []), `actor.${kind}`],
    ...(kind === "unknown" ? { reason: "missing dispatch actor context" } : {}),
  });
}
