import { type Actor, Command } from "@openomni/protocol";
import { WorkItemAttemptRun } from "@openomni/ledger";

export interface DispatchRuntimeContext {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agentName?: string;
  readonly workspaceRoot?: string;
  readonly traceId?: string;
  readonly actorKind?: Actor.Kind;
  readonly actorId?: string;
  readonly trustTier?: Actor.TrustTier;
  readonly labels?: readonly string[];
}

// #498 A2 — derivation speaks THE canonical Actor.Kind: an agent-run actor is
// an "internal_worker" (the retired command-local "worker" value).
function actorKindFromAgent(agentName: string | undefined): Actor.Kind {
  if (!agentName) return "unknown";
  const normalized = agentName.trim().toLowerCase();
  if (normalized === "resident") return "resident";
  if (normalized === "system" || normalized === "scheduler") return "system";
  return "internal_worker";
}

// #510 D2b — run existence derives from WorkItem attempt facts; frozen
// legacy worker_run_state rows keep answering through the upcast view.
//
// An UNREADABLE store is NOT "no run" (audit batch A): swallowing the read
// error let a run whose attempt row could not be read fall through to
// agentName inference — a caller-influenced string like "resident" then
// derived a privileged kind the dispatch policy default-allows. The failure
// surfaces as its own state; inference derives kind "unknown", which the
// dispatch default-authority policy denies (fail-closed).
type WorkerRunLookup = "found" | "absent" | "unreadable";

function lookupWorkerRun(
  sessionId: string | undefined,
  runId: string | undefined,
): WorkerRunLookup {
  if (!sessionId || !runId) return "absent";
  try {
    return WorkItemAttemptRun.find(sessionId, runId) ? "found" : "absent";
  } catch {
    return "unreadable";
  }
}

function deriveTrustTier(
  context: DispatchRuntimeContext,
  hasWorkerRun: boolean,
): Actor.TrustTier | undefined {
  if (context.trustTier) return context.trustTier;
  return hasWorkerRun ? "assigned_worker" : undefined;
}

export function deriveActorContext(context: DispatchRuntimeContext = {}): Command.ActorContext {
  const workerRun = lookupWorkerRun(context.sessionId, context.runId);
  // An explicitly supplied actorKind is the runtime wiring's own authority
  // and stands; only the INFERENCE path fails closed on an unreadable store.
  const kind =
    context.actorKind ??
    (workerRun === "unreadable"
      ? "unknown"
      : workerRun === "found"
        ? "internal_worker"
        : actorKindFromAgent(context.agentName));
  const trustTier = deriveTrustTier(context, workerRun === "found");
  const actorId =
    context.actorId ??
    (context.sessionId && context.runId
      ? `${context.sessionId}:${context.runId}`
      : context.agentName
        ? `agent:${context.agentName}`
        : "unknown");

  return Command.ActorContext.parse({
    kind,
    actorId,
    ...(context.agentName ? { agentName: context.agentName } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.runId && kind === "internal_worker" ? { workerRunId: context.runId } : {}),
    ...(context.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
    ...(trustTier ? { trustTier } : {}),
    labels: [...(context.labels ?? []), `actor.${kind}`],
    ...(kind === "unknown"
      ? {
          reason:
            workerRun === "unreadable"
              ? "worker run lookup failed"
              : "missing dispatch actor context",
        }
      : {}),
  });
}
