import { type Actor, Ingress, Policy, PolicyDecision, type TraceContext } from "@openomni/protocol";
import type { ChannelGrantStore } from "@openomni/session";
import type { ZodError } from "zod";
import type { CoordinatorLike } from "../coordinator-like";
import { IngressPolicyGate } from "../policy-gate";
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

interface PreRunState {
  readonly input: unknown;
  readonly coordinator?: CoordinatorLike;
  parsedEvent?: Ingress.DirectEvent;
  schemaError?: ZodError;
  mode?: Ingress.DirectEvent["mode"];
  target?: Ingress.Target;
}

interface PreRunContext {
  readonly event: unknown;
  readonly coordinator?: CoordinatorLike;
  readonly traceContext?: TraceContext.Type;
  readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
}

interface PreRunResult {
  readonly event: Ingress.DirectEvent;
  readonly coordinator?: CoordinatorLike;
  readonly mode: Ingress.DirectEvent["mode"];
  readonly target: Ingress.Target;
}

function allowDecision(policyId: string, reason: string): Policy.PolicyDecision {
  return PolicyDecision.allow({ policyId, reasonCodes: [reason] });
}

function abortDecision(policyId: string, reason: string): Policy.PolicyDecision {
  return PolicyDecision.deny({
    policyId,
    reasonCodes: [reason],
    effects: [{ type: "run.abort", reason }],
  });
}

function requireParsedEvent(state: PreRunState): Ingress.DirectEvent {
  if (!state.parsedEvent) {
    throw new Error("ingress event must be schema-validated before authority middleware");
  }
  return state.parsedEvent;
}

function throwAbort(decision: Policy.PolicyDecision, state: PreRunState): never {
  if (state.schemaError) throw state.schemaError;
  throw new Error(PolicyDecision.reason(decision, "ingress routed pre-run policy aborted"));
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

export function applyChannelGrantTreatment(
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
  export async function runRoutedPreRun(ctx: PreRunContext): Promise<PreRunResult> {
    const state: PreRunState = { input: ctx.event, coordinator: ctx.coordinator };
    // #530: the routed pre-run checks run on the kernel-local gate runner.
    // No canonical policy point fits this boundary honestly — the event is
    // pre-schema-validation, pre-session, and pre-run, and anonymous actors
    // are legal here — so this is deliberately NOT a policy-engine dispatch.
    const gateContext: IngressPolicyGate.PreRunContext = {
      gate: "pre-run",
      ...(ctx.traceContext !== undefined && { traceContext: ctx.traceContext }),
    };
    const decision = await IngressPolicyGate.evaluate(
      routedPreRunPolicies(state),
      gateContext,
      ctx.onDecision,
    );

    if (PolicyDecision.isBlocking(decision)) throwAbort(decision, state);
    if (!state.parsedEvent || !state.mode) {
      throw new Error("ingress run.start middleware did not produce dispatch context");
    }
    const target = state.target ?? resolveTarget(state.parsedEvent);
    if (targetRequiresCoordinator(target) && !state.coordinator) {
      throw new Error("ingress run.start middleware did not produce coordinator for worker target");
    }

    return {
      event: state.parsedEvent,
      coordinator: state.coordinator,
      mode: state.mode,
      target,
    };
  }

  function routedPreRunPolicies(state: PreRunState): IngressPolicyGate.IngressPolicy[] {
    return [
      createSchemaValidation(state),
      createCoordinatorPresence(state),
      createAuthorityCheck(state),
      createModeDispatch(state),
    ];
  }

  function createSchemaValidation(state: PreRunState): IngressPolicyGate.IngressPolicy {
    return {
      name: "ingress:schema-validation",
      gate: "pre-run",
      priority: 0,
      failPolicy: "fail-closed",
      fn: () => {
        const parsed = Ingress.DirectEventSchema.safeParse(state.input);
        if (!parsed.success) {
          state.schemaError = parsed.error;
          return abortDecision("ingress.schema", "invalid ingress event");
        }

        state.parsedEvent = parsed.data;
        return allowDecision("ingress.schema", "ingress event schema valid");
      },
    };
  }

  function createCoordinatorPresence(state: PreRunState): IngressPolicyGate.IngressPolicy {
    return {
      name: "ingress:coordinator-presence",
      gate: "pre-run",
      priority: 10,
      failPolicy: "fail-closed",
      fn: () => {
        const event = requireParsedEvent(state);
        const target = resolveTarget(event);
        state.target = target;

        if (!targetRequiresCoordinator(target)) {
          return allowDecision(
            "ingress.coordinator",
            "coordinator not required for resident target",
          );
        }
        if (state.coordinator === undefined) {
          return abortDecision(
            "ingress.coordinator",
            `coordinator is required for ${target.kind} target`,
          );
        }
        return allowDecision(
          "ingress.coordinator",
          `coordinator available for ${target.kind} target`,
        );
      },
    };
  }

  function createAuthorityCheck(state: PreRunState): IngressPolicyGate.IngressPolicy {
    return {
      name: "ingress:authority",
      gate: "pre-run",
      priority: 20,
      failPolicy: "fail-closed",
      fn: () => {
        const event = requireParsedEvent(state);

        return evaluateIngressAuthority(event);
      },
    };
  }

  function createModeDispatch(state: PreRunState): IngressPolicyGate.IngressPolicy {
    return {
      name: "ingress:mode-dispatch",
      gate: "pre-run",
      priority: 35,
      failPolicy: "fail-closed",
      fn: () => {
        const event = requireParsedEvent(state);
        if (event.mode !== "direct") {
          const unknownMode: unknown = event.mode;
          return abortDecision("ingress.mode", `unknown ingress mode: ${unknownMode}`);
        }

        state.mode = event.mode;
        return allowDecision("ingress.mode", `dispatch mode ${event.mode}`);
      },
    };
  }
}
