import { PolicyDecision, type Dispatch, type Policy } from "@openomni/protocol";
import type { PolicyRegistration } from "@openomni/agent";

function deny(reason: string): Policy.PolicyDecision {
  return PolicyDecision.deny({
    policyId: "dispatch.default-authority",
    reasonCodes: [reason],
    effects: [
      { type: "run.abort", reason },
      { type: "audit.annotate", annotation: reason, severity: "error" },
    ],
  });
}

function allow(reason: string): Policy.PolicyDecision {
  return PolicyDecision.allow({
    policyId: "dispatch.default-authority",
    reasonCodes: [reason],
    effects: [{ type: "audit.annotate", annotation: reason, severity: "info" }],
  });
}

export function createDefaultDispatchPolicy(): PolicyRegistration {
  return {
    name: "dispatch.default-authority",
    timing: "dispatch.authorize",
    priority: 0,
    failPolicy: "fail-closed",
    fn(ctx) {
      const input = ctx.toolInput as { actor?: Dispatch.ActorContext; action?: unknown };
      const action = typeof input.action === "string" ? input.action : "";
      const actor = input.actor;

      if (!actor || actor.kind === "unknown") {
        return deny("dispatch.actor.required");
      }

      if (actor.kind === "worker" && action === "worker.spawn") {
        return deny("dispatch.worker.spawn.denied");
      }

      if (actor.kind === "worker" && action.startsWith("schedule.")) {
        return deny("dispatch.worker.schedule.denied");
      }

      if (actor.kind === "worker" && action === "resident.deliver") {
        return allow("dispatch.worker.resident_deliver.allowed");
      }

      if (actor.kind === "system" && action.startsWith("schedule.")) {
        return allow("dispatch.system.schedule.allowed");
      }

      return allow("dispatch.default.allowed");
    },
  };
}
