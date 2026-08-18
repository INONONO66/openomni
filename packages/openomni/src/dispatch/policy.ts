import { Command, PolicyDecision, type Policy } from "@openomni/protocol";
import type { GenericPolicyContext } from "@openomni/policy";
import { BlacklistStore, PendingInteractionStore, WorkerGrantStore } from "@openomni/session";
import { EffectiveAuthority } from "./effective-authority.js";
import type { DispatchPolicyRegistration } from "./policy-registration.js";

export interface DispatchPolicyContext extends GenericPolicyContext {
  readonly actor?: Command.ActorContext;
  readonly dispatchId?: string;
  readonly action?: string;
  readonly target?: Command.Target;
  readonly correlation?: Command.Request["correlation"];
  readonly sessionId?: string;
  readonly runId?: string;
}

function deny(reason: string, factsUsed: readonly string[] = []): Policy.PolicyDecision {
  return PolicyDecision.deny({
    policyId: "dispatch.default-authority",
    reasonCodes: [reason],
    factsUsed: [...factsUsed],
    effects: [
      { type: "run.abort", reason },
      { type: "audit.annotate", annotation: reason, severity: "error" },
    ],
  });
}

function allow(reason: string, factsUsed: readonly string[] = []): Policy.PolicyDecision {
  return PolicyDecision.allow({
    policyId: "dispatch.default-authority",
    reasonCodes: [reason],
    factsUsed: [...factsUsed],
    effects: [{ type: "audit.annotate", annotation: reason, severity: "info" }],
  });
}

function decide(result: EffectiveAuthority.Result): Policy.PolicyDecision {
  return result.allowed
    ? allow(result.reason, result.factsUsed)
    : deny(result.reason, result.factsUsed);
}

function blacklistMatchInput(
  actor: Command.ActorContext | undefined,
  target: Command.Target | undefined,
  correlation: Command.Request["correlation"] | undefined,
) {
  const correlationHints = typeof correlation === "object" ? correlation : undefined;
  return {
    actorId: actor?.actorId,
    endpointId:
      correlationHints?.endpointId ??
      (target?.kind === "external_actor" ? (target.id ?? target.name) : undefined),
    channel:
      correlationHints?.channelId ??
      (target?.kind === "surface" ? (target.id ?? target.name) : undefined),
    candidates: [
      ...(target?.id ? [target.id] : []),
      ...(target?.name ? [target.name] : []),
      ...(target?.labels ?? []),
      ...(correlationHints?.endpointId ? [correlationHints.endpointId] : []),
      ...(correlationHints?.channelId ? [correlationHints.channelId] : []),
    ],
  };
}

export function createDefaultDispatchPolicy(): DispatchPolicyRegistration {
  return {
    kind: "point",
    name: "dispatch.default-authority",
    pointIds: ["dispatch.action.pre"],
    effectCapabilities: {
      "dispatch.action.pre": ["audit.annotate", "run.abort"],
    },
    priority: 0,
    failPolicy: "fail-closed",
    fn(ctx) {
      const action = ctx.action ?? "";
      const actor = ctx.actor;
      const target = ctx.target;
      const blacklisted = BlacklistStore.match(blacklistMatchInput(actor, target, ctx.correlation));
      if (blacklisted) {
        return decide(
          EffectiveAuthority.blockedByBlacklist(
            blacklisted.reason ?? `dispatch.blacklist.${blacklisted.kind}.${blacklisted.value}`,
            blacklisted.kind,
          ),
        );
      }

      if (!actor || actor.kind === "unknown") {
        return decide(EffectiveAuthority.missingActor());
      }

      if (action === "worker.spawn" && actor.kind !== "resident") {
        return decide(
          actor.kind === "worker"
            ? EffectiveAuthority.workerDenied("dispatch.worker.spawn.denied")
            : EffectiveAuthority.actorDenied("dispatch.worker.spawn.resident_required"),
        );
      }

      if (actor.kind === "worker" && action.startsWith("schedule.")) {
        const granted = evaluateWorkerGrant(actor, action, target, requireDispatchTraceId(ctx));
        return decide(EffectiveAuthority.workerGrant(granted, "dispatch.worker.schedule.denied"));
      }

      if (actor.kind === "worker" && action === "resident.ask") {
        if (target?.kind !== "resident") {
          return decide(
            EffectiveAuthority.workerDenied("dispatch.worker.resident_ask.target.denied"),
          );
        }
        return decide(EffectiveAuthority.workerNotRequired("dispatch.worker.resident_ask.allowed"));
      }

      if (action === Command.Actions.ActorMessage) {
        return decide(
          EffectiveAuthority.pendingInteractionDenied("dispatch.pending_interaction.required"),
        );
      }

      if (
        actor.kind === "worker" &&
        (action === Command.Actions.ActorReply || action === Command.Actions.WorkerComplete) &&
        actor.trustTier === "assigned_worker"
      ) {
        const pendingInteraction = evaluatePendingInteractionScope(actor, action, target);
        if (pendingInteraction.allowed) {
          return decide(
            EffectiveAuthority.pendingInteraction(
              "dispatch.pending_interaction.allowed",
              pendingInteraction.id,
            ),
          );
        }
        return decide(EffectiveAuthority.pendingInteractionDenied(pendingInteraction.reason));
      }

      if (actor.kind === "worker" && isWorkerScopedEgress(action)) {
        const granted = evaluateWorkerGrant(actor, action, target, requireDispatchTraceId(ctx));
        return decide(EffectiveAuthority.workerGrant(granted, "dispatch.worker.scope.denied"));
      }

      if (actor.kind === "worker" && isExternalEgress(action)) {
        const granted = evaluateWorkerGrant(actor, action, target, requireDispatchTraceId(ctx));
        return decide(EffectiveAuthority.workerGrant(granted, "dispatch.worker.external.denied"));
      }

      if (actor.kind === "system" && action.startsWith("schedule.")) {
        return decide(EffectiveAuthority.nonWorker("dispatch.system.schedule.allowed"));
      }

      if (actor.kind === "worker") {
        return decide(EffectiveAuthority.workerDenied("dispatch.worker.action.denied"));
      }

      return decide(EffectiveAuthority.nonWorker("dispatch.default.allowed"));
    },
  };
}

function evaluatePendingInteractionScope(
  actor: Command.ActorContext,
  action: string,
  target: Command.Target | undefined,
): { allowed: true; id: string } | { allowed: false; reason: string } {
  if (actor.reason !== "pending_interaction.match") {
    return { allowed: false, reason: "dispatch.pending_interaction.match.required" };
  }
  const pendingInteractionId = actor.labels
    ?.find((label) => label.startsWith("pending_interaction."))
    ?.slice("pending_interaction.".length);
  if (!pendingInteractionId) {
    return { allowed: false, reason: "dispatch.pending_interaction.required" };
  }
  const record = PendingInteractionStore.get(pendingInteractionId);
  if (!record) {
    return { allowed: false, reason: "dispatch.pending_interaction.not_found" };
  }
  const requiredAction =
    action === Command.Actions.WorkerComplete ? "report_result" : "attach_artifact";
  if (!record.allowedActions.includes(requiredAction)) {
    return { allowed: false, reason: "dispatch.pending_interaction.action.denied" };
  }
  if (target?.kind !== "worker") {
    return { allowed: false, reason: "dispatch.pending_interaction.target.denied" };
  }
  if (record.workerRunId !== target.runId || record.workerRunId !== actor.workerRunId) {
    return { allowed: false, reason: "dispatch.pending_interaction.run_mismatch" };
  }
  if (record.sessionId !== target.sessionId || record.sessionId !== actor.sessionId) {
    return { allowed: false, reason: "dispatch.pending_interaction.session_mismatch" };
  }
  return { allowed: true, id: record.id };
}

function isExternalCreate(action: string): boolean {
  return action === "external.ask" || action === "a2a.ask" || action === "api.ask";
}

function isExternalEgress(action: string): boolean {
  return action.startsWith("external.") || action.startsWith("a2a.") || action.startsWith("api.");
}

function isWorkerScopedEgress(action: string): boolean {
  return action === "worker.send" || action === "worker.resume" || action === "worker.cancel";
}

// A missing trace here is a wiring bug: the runtime builds every dispatch
// point's traceContext from the command. The policy is fail-closed, so the
// throw surfaces as an unconditional deny — never a mint. The middleware
// error record is trace-gated: it files because the runtime also gives the
// ENGINE the command trace (with neither trace, the engine denies silently).
function requireDispatchTraceId(ctx: {
  readonly traceContext?: { readonly traceId?: string };
}): string {
  const traceId = ctx.traceContext?.traceId;
  if (traceId === undefined || traceId.length === 0) {
    throw new Error("worker grant evaluation requires the command trace context");
  }
  return traceId;
}

function evaluateWorkerGrant(
  actor: Command.ActorContext,
  action: string,
  target: Command.Target | undefined,
  traceId: string,
): { allowed: boolean; reason: string } {
  if (!actor.workerRunId) return { allowed: false, reason: "worker_grant.worker_run.required" };
  return WorkerGrantStore.evaluate({
    traceId,
    workerRunId: actor.workerRunId,
    action,
    sessionId: target?.sessionId ?? target?.parentSessionId ?? actor.sessionId,
    actorId: target?.id ?? target?.name ?? actor.actorId,
    endpointId: target?.id ?? target?.name,
    createsExternalTask: isExternalCreate(action),
  });
}
