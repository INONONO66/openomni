import { Policy, PolicyDecision, type Ingress } from "@openomni/protocol";
import { resolveTarget, targetKey } from "../target";
import {
  actionLabels,
  actorRole,
  actorTrustTier,
  getActor,
  getEventAction,
  isAuthorizedTopLevelActor,
} from "./ingress-authority-actor";

const authorityInputRules = [
  {
    toolPattern: "",
    field: "actionPermission",
    pattern: "^worker\\.spawn$",
    action: "deny",
    reason: "worker cannot spawn workers",
    priority: 4,
  },
  {
    toolPattern: "",
    field: "actionPermission",
    pattern: "^worker\\.cancel$",
    action: "deny",
    reason: "worker cannot cancel workers",
    priority: 4,
  },
  {
    toolPattern: "",
    field: "actionPermission",
    pattern: "^worker\\.resume$",
    action: "deny",
    reason: "worker cannot resume workers",
    priority: 4,
  },
  {
    toolPattern: "",
    field: "actionPermission",
    pattern: "^worker\\.schedule$",
    action: "deny",
    reason: "worker cannot schedule workers",
    priority: 4,
  },
  {
    toolPattern: "",
    field: "actionPermission",
    pattern: "^resident\\.(spawn|send|cancel|resume|schedule)$",
    action: "allow",
    reason: "resident authorized for worker control action",
    priority: 3,
  },
  {
    toolPattern: "",
    field: "actionPermission",
    pattern: "^worker\\.send$",
    action: "allow",
    reason: "worker authorized to send worker messages",
    priority: 3,
  },
  {
    toolPattern: "",
    field: "authorized",
    pattern: "^true$",
    action: "allow",
    reason: "actor authorized for top-level inbound work",
    priority: 2,
  },
  {
    toolPattern: "",
    field: "authorized",
    pattern: "^false$",
    action: "deny",
    reason: "actor is not authorized to create top-level inbound work",
    priority: 1,
  },
] as const satisfies readonly Policy.InputRule[];

export function evaluateIngressAuthority(event: Ingress.InboundEvent): Policy.PolicyDecision {
  const target = resolveTarget(event);
  const actor = getActor(event);
  const role = actorRole(actor);
  const trustTier = actorTrustTier(actor);
  const permissionActor = trustTier ?? role;
  const eventAction = getEventAction(event);
  const action = target.kind === "worker" ? "ingress.worker.deliver" : "ingress.top_level.create";
  const resource = `ingress.${event.surface}.${targetKey(target)}`;
  const resourceLabels = [
    `surface.${event.surface}`,
    `target.${target.kind}`,
    ...(role ? [`actor.${role}`] : []),
    ...(trustTier ? [`trust.${trustTier}`] : []),
    ...(eventAction ? [actionLabels[eventAction]] : []),
  ];
  const decision = PolicyDecision.fromEvaluation(
    Policy.evaluate(
      {
        action,
        inputRules: authorityInputRules.map((rule) => ({ ...rule, toolPattern: resource })),
      },
      {
        action,
        resource,
        resourceLabels,
        actor,
        input: {
          actionPermission: eventAction ? `${permissionActor}.${eventAction}` : "",
          authorized: String(isAuthorizedTopLevelActor(event)),
        },
        metadata: { action: eventAction, mode: event.mode, surface: event.surface, target },
      },
    ),
  );

  return { ...decision, factsUsed: resourceLabels };
}
