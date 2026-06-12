import { PolicyDecision, type Dispatch, type Policy } from "@openomni/protocol";
import type { PolicyRegistration } from "@openomni/agent";
import { BlacklistStore, WorkerGrantStore } from "@openomni/session";
import { EffectiveAuthority } from "./effective-authority.js";

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

function blacklistReason(kind: string, value: string, reason: string | undefined): string {
  return reason ?? `dispatch.blacklist.${kind}.${value}`;
}

function blacklistMatchInput(
  actor: Dispatch.ActorContext | undefined,
  target: Dispatch.Target | undefined,
) {
  return {
    actorId: actor?.actorId,
    endpointId: target?.kind === "external_actor" ? (target.id ?? target.name) : undefined,
    channel: target?.kind === "surface" ? (target.id ?? target.name) : undefined,
    candidates: [
      ...(target?.id ? [target.id] : []),
      ...(target?.name ? [target.name] : []),
      ...(target?.labels ?? []),
    ],
  };
}

export function createDefaultDispatchPolicy(): PolicyRegistration {
  return {
    name: "dispatch.default-authority",
    timing: "dispatch.authorize",
    priority: 0,
    failPolicy: "fail-closed",
    fn(ctx) {
      const input = ctx.toolInput as {
        actor?: Dispatch.ActorContext;
        action?: unknown;
        target?: Dispatch.Target;
      };
      const action = typeof input.action === "string" ? input.action : "";
      const actor = input.actor;
      const target = input.target;
      const blacklisted = BlacklistStore.match(blacklistMatchInput(actor, target));
      if (blacklisted) {
        return decide(
          EffectiveAuthority.blockedByBlacklist(
            blacklistReason(blacklisted.kind, blacklisted.value, blacklisted.reason),
            blacklisted.kind,
          ),
        );
      }

      if (!actor || actor.kind === "unknown") {
        return decide(EffectiveAuthority.missingActor());
      }

      if (actor.kind === "worker" && action === "worker.spawn") {
        const granted = evaluateWorkerGrant(actor, action, target);
        return decide(EffectiveAuthority.workerGrant(granted, "dispatch.worker.spawn.denied"));
      }

      if (actor.kind === "worker" && action.startsWith("schedule.")) {
        const granted = evaluateWorkerGrant(actor, action, target);
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

      if (actor.kind === "worker" && isWorkerScopedEgress(action)) {
        const granted = evaluateWorkerGrant(actor, action, target);
        return decide(EffectiveAuthority.workerGrant(granted, "dispatch.worker.scope.denied"));
      }

      if (actor.kind === "worker" && isExternalEgress(action)) {
        const granted = evaluateWorkerGrant(actor, action, target, isExternalCreate(action));
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

function isExternalCreate(action: string): boolean {
  return action === "external.ask" || action === "a2a.ask" || action === "api.ask";
}

function isExternalEgress(action: string): boolean {
  return action.startsWith("external.") || action.startsWith("a2a.") || action.startsWith("api.");
}

function isWorkerScopedEgress(action: string): boolean {
  return action === "worker.send" || action === "worker.resume" || action === "worker.cancel";
}

function evaluateWorkerGrant(
  actor: Dispatch.ActorContext,
  action: string,
  target: Dispatch.Target | undefined,
  createsExternalTask = false,
): { allowed: boolean; reason: string } {
  if (!actor.workerRunId) return { allowed: false, reason: "worker_grant.worker_run.required" };
  return WorkerGrantStore.evaluate({
    workerRunId: actor.workerRunId,
    action,
    sessionId: target?.sessionId ?? target?.parentSessionId ?? actor.sessionId,
    actorId: target?.id ?? target?.name ?? actor.actorId,
    endpointId: target?.id ?? target?.name,
    createsExternalTask,
  });
}
