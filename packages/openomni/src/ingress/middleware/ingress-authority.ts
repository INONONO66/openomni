import { type Actor, Ingress, type Policy, PolicyDecision } from "@openomni/protocol";
import { decisionFromEvaluation, evaluatePermission } from "@openomni/policy";
import type { ChannelGrantStore } from "@openomni/session";
import type { CoordinatorLike } from "../coordinator-like";
import { resolveTarget, targetKey } from "../target";
import {
  actionLabels,
  actorRole,
  actorTrustTier,
  getActor,
  getEventAction,
  isAuthorizedTopLevelActor,
  targetRequiresCoordinator,
} from "./ingress-authority-actor";

interface PreRunContext {
  readonly event: unknown;
  readonly coordinator?: CoordinatorLike;
  readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
}

interface PreRunResult {
  readonly event: Ingress.DirectEvent;
  readonly coordinator?: CoordinatorLike;
  readonly mode: Ingress.DirectEvent["mode"];
  readonly target: Ingress.Target;
}

function notifyDecision(
  onDecision: PreRunContext["onDecision"],
  decision: Policy.PolicyDecision,
): void {
  if (!onDecision) return;
  try {
    // Observers must not block or fail the routed pre-run.
    void Promise.resolve(onDecision(decision)).catch(() => undefined);
  } catch {
    // Synchronous observer errors are isolated the same way.
  }
}

// Blacklist and channel-grant enforcement is owned by the routing pipeline
// (routing-resolution + resolve-route); this middleware only covers the routed
// pre-run checks that run after routing has admitted the event.
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

function evaluateIngressAuthority(event: Ingress.InboundEvent): Policy.PolicyDecision {
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
  const decision = decisionFromEvaluation(
    evaluatePermission(
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

export /**
 * Stamps the treatment onto meta VERBATIM — no runtime validation against
 * Actor.InboundTreatment. Today every producer is schema-derived (grants are
 * Zod-parsed at write and read, and routing-resolution passes the parsed
 * value), but a future caller bypassing those types stamps garbage into meta
 * unchecked — a test carried an out-of-enum value through here for a year
 * (#652 review). Convergence of this seam belongs to #498.
 */
function applyChannelGrantTreatment(
  event: Ingress.DirectEvent,
  grant: ChannelGrantStore.Grant,
  inboundTreatment: Actor.InboundTreatment,
): Ingress.DirectEvent {
  const actor = getActor(event);
  // A channel defaultTier materializes a principal for senders on the granted
  // channel — including fully anonymous ones. That is Owner-authored channel
  // policy, not a sender claim: grant rows are written by the Owner, scoped to
  // surface/workspace/channel, and the transport was authenticated by the
  // channel adapter. Pinned by kernel-routing-access "materializes a
  // default-tier stranger". Tier-range validation at grant-write time is a
  // #498 Grant-convergence candidate, not a treatment-time concern.
  const actorWithChannelDefault =
    !actorTrustTier(actor) && grant.defaultTier
      ? { ...(actor ?? { role: "user" }), trustTier: grant.defaultTier }
      : actor;

  return {
    ...event,
    meta: {
      ...event.meta,
      ...(actorWithChannelDefault ? { actor: actorWithChannelDefault } : {}),
      channelGrantId: grant.id,
      channelGrantKind: grant.kind,
      inboundTreatment,
    },
  };
}

export namespace IngressAuthorityMiddleware {
  /**
   * The routed pre-run admission checks. No canonical policy point fits this
   * boundary honestly — the event is pre-schema-validation, pre-session, and
   * pre-run, and anonymous actors are legal here — so these run as plain
   * sequential steps, aborting on the FIRST failure (schema → coordinator →
   * authority → mode). Only the authority check is real authorization: an
   * unconditional direct `Policy.evaluate` whose decision is fanned to the
   * observer. Schema, coordinator presence, and mode dispatch are pipeline
   * mechanics — they throw directly and are not observed as policy decisions.
   */
  export async function runRoutedPreRun(ctx: PreRunContext): Promise<PreRunResult> {
    // schema (fail-closed): the original ZodError is the abort surface.
    const parsed = Ingress.DirectEventSchema.safeParse(ctx.event);
    if (!parsed.success) throw parsed.error;
    const event = parsed.data;

    // coordinator presence for worker targets.
    const target = resolveTarget(event);
    if (targetRequiresCoordinator(target) && ctx.coordinator === undefined) {
      throw new Error(`coordinator is required for ${target.kind} target`);
    }

    // authority: unconditional on every routed pre-run, fanned to the observer.
    const decision = evaluateIngressAuthority(event);
    notifyDecision(ctx.onDecision, decision);
    if (PolicyDecision.isBlocking(decision)) {
      throw new Error(PolicyDecision.reason(decision, "ingress routed pre-run policy aborted"));
    }

    // mode dispatch.
    if (event.mode !== "direct") {
      const unknownMode: unknown = event.mode;
      throw new Error(`unknown ingress mode: ${unknownMode}`);
    }

    return { event, coordinator: ctx.coordinator, mode: event.mode, target };
  }
}
