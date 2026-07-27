import { Dispatch, PolicyDecision, type Policy } from "@openomni/protocol";
import type { GenericPolicyContext } from "@openomni/policy";
import {
  authoritySourceFacts,
  type AuthorityProjectionQueryPort,
} from "../ingress/actor-resolver.js";
import { EffectiveAuthority } from "./effective-authority.js";
import type { DispatchPolicyRegistration } from "./policy-registration.js";

export interface DispatchPolicyContext extends GenericPolicyContext {
  readonly actor?: Dispatch.ActorContext;
  readonly dispatchId?: string;
  readonly action?: string;
  readonly target?: Dispatch.Target;
  readonly correlation?: Dispatch.Command["correlation"];
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

function decide(
  result: EffectiveAuthority.Result,
  authorityFacts: readonly string[] = [],
): Policy.PolicyDecision {
  const factsUsed = [...result.factsUsed, ...authorityFacts];
  return result.allowed ? allow(result.reason, factsUsed) : deny(result.reason, factsUsed);
}

function blacklistMatchInput(
  actor: Dispatch.ActorContext | undefined,
  target: Dispatch.Target | undefined,
  correlation: Dispatch.Command["correlation"] | undefined,
) {
  const correlationHints = typeof correlation === "object" ? correlation : undefined;
  const endpointId =
    correlationHints?.endpointId ??
    (target?.kind === "external_actor" ? (target.id ?? target.name) : undefined);
  const channel =
    correlationHints?.channelId ??
    (target?.kind === "surface" ? (target.id ?? target.name) : undefined);
  return {
    ...(actor?.actorId === undefined ? {} : { actorId: actor.actorId }),
    ...(endpointId === undefined ? {} : { endpointId }),
    ...(channel === undefined ? {} : { channel }),
    candidates: [
      ...(target?.id ? [target.id] : []),
      ...(target?.name ? [target.name] : []),
      ...(target?.labels ?? []),
      ...(correlationHints?.endpointId ? [correlationHints.endpointId] : []),
      ...(correlationHints?.channelId ? [correlationHints.channelId] : []),
    ],
  };
}

function matchedWaitId(actor: Dispatch.ActorContext): string | undefined {
  if (
    actor.kind !== "worker" ||
    actor.trustTier !== "assigned_worker" ||
    actor.reason !== "wait.match" ||
    !actor.sessionId ||
    !actor.runId ||
    actor.workerRunId !== actor.runId
  ) {
    return undefined;
  }
  const labels = actor.labels ?? [];
  if (!labels.includes("actor.worker") || !labels.includes("actor.assigned_worker")) {
    return undefined;
  }
  const waitLabels = labels.filter((label) => label.startsWith("wait.") && label.length > 5);
  return waitLabels.length === 1 ? waitLabels[0]?.slice(5) : undefined;
}

function isExactMatchedWaitTarget(
  action: string,
  actor: Dispatch.ActorContext,
  target: Dispatch.Target | undefined,
  sessionId: string | undefined,
  runId: string | undefined,
): boolean {
  if (
    sessionId !== actor.sessionId ||
    runId !== actor.runId ||
    target?.sessionId !== actor.sessionId
  ) {
    return false;
  }
  if (action === Dispatch.Actions.WorkerComplete) {
    return target?.kind === "worker" && target.runId === actor.runId && target.id === actor.runId;
  }
  return action === Dispatch.Actions.ResidentAsk && target?.kind === "resident";
}

export function createDefaultDispatchPolicy(
  queries: AuthorityProjectionQueryPort,
): DispatchPolicyRegistration {
  return {
    kind: "point",
    name: "dispatch.default-authority",
    pointIds: ["dispatch.action.pre"],
    effectCapabilities: {
      "dispatch.action.pre": ["audit.annotate", "run.abort"],
    },
    priority: 0,
    failPolicy: "fail-closed",
    async fn(ctx) {
      const action = ctx.action ?? "";
      const actor = ctx.actor;
      const target = ctx.target;
      const blacklistResult = await queries.query({
        kind: "authority.blacklist_match",
        ...blacklistMatchInput(actor, target, ctx.correlation),
      });
      if (blacklistResult.kind !== "authority.blacklist_match") {
        throw new TypeError("authority blacklist query returned the wrong projection kind");
      }
      const blacklistFacts = authoritySourceFacts(blacklistResult);
      if (blacklistResult.entry !== null) {
        return decide(
          EffectiveAuthority.blockedByBlacklist(
            blacklistResult.entry.reason ??
              `dispatch.blacklist.${blacklistResult.entry.kind}.${blacklistResult.entry.value}`,
            blacklistResult.entry.kind,
          ),
          blacklistFacts,
        );
      }

      if (!actor || actor.kind === "unknown") {
        return decide(EffectiveAuthority.missingActor(), blacklistFacts);
      }

      if (action === "worker.spawn" && actor.kind !== "resident") {
        return decide(
          actor.kind === "worker"
            ? EffectiveAuthority.workerDenied("dispatch.worker.spawn.denied")
            : EffectiveAuthority.actorDenied("dispatch.worker.spawn.resident_required"),
          blacklistFacts,
        );
      }

      const waitId = actor.kind === "worker" ? matchedWaitId(actor) : undefined;
      if (
        waitId !== undefined &&
        isExactMatchedWaitTarget(action, actor, target, ctx.sessionId, ctx.runId)
      ) {
        return decide(
          EffectiveAuthority.pendingInteraction("dispatch.wait_response.allowed", waitId),
          blacklistFacts,
        );
      }
      if (actor.kind === "worker" && action === "resident.ask") {
        if (target?.kind !== "resident") {
          return decide(
            EffectiveAuthority.workerDenied("dispatch.worker.resident_ask.target.denied"),
            blacklistFacts,
          );
        }
        if (
          actor.trustTier !== "assigned_worker" ||
          !actor.workerRunId ||
          !actor.sessionId ||
          !actor.runId
        ) {
          return decide(
            EffectiveAuthority.workerDenied("dispatch.worker.resident_ask.authentication.denied"),
            blacklistFacts,
          );
        }
        return decide(
          EffectiveAuthority.workerNotRequired("dispatch.worker.resident_ask.allowed"),
          blacklistFacts,
        );
      }

      if (action === Dispatch.Actions.ActorMessage) {
        return decide(
          EffectiveAuthority.pendingInteractionDenied("dispatch.pending_interaction.required"),
          blacklistFacts,
        );
      }

      if (actor.kind === "system" && action.startsWith("schedule.")) {
        return decide(
          EffectiveAuthority.nonWorker("dispatch.system.schedule.allowed"),
          blacklistFacts,
        );
      }

      if (actor.kind === "worker") {
        return decide(
          EffectiveAuthority.workerDenied("dispatch.worker.action.denied"),
          blacklistFacts,
        );
      }

      return decide(EffectiveAuthority.nonWorker("dispatch.default.allowed"), blacklistFacts);
    },
  };
}
