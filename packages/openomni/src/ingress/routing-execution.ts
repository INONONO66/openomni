import { Command, Wait, type Ingress } from "@openomni/protocol";
import type { TraceContext } from "@openomni/protocol";
import { submitPinnedPendingInteraction, type DispatchRuntime } from "../dispatch/runtime.js";
import { WaitService, targetsOfWait } from "../wait/index.js";
import { IngressRoutingError, type KernelRouteResolution } from "./routing-resolution.js";

type RoutedDecision = Extract<Ingress.RoutingDecisionPayload, { readonly outcome: "route" }>;

type BlacklistDropDecision = Extract<
  Ingress.RoutingDecisionPayload,
  { readonly stage: "blacklist"; readonly outcome: "drop" }
>;
type AcceptedDecision = RoutedDecision | BlacklistDropDecision;

function factValue(decision: Ingress.RoutingDecisionPayload, prefix: string): string | undefined {
  const fact = decision.factsUsed.find((candidate) => candidate.startsWith(prefix));
  return fact?.slice(prefix.length);
}

function terminalMessage(decision: Ingress.RoutingDecisionPayload): string {
  if (decision.stage === "blacklist") {
    return factValue(decision, "blacklist.reason:") ?? decision.reason;
  }
  if (decision.stage === "channel_ceiling") {
    if (decision.factsUsed.includes("channel:missing")) return "channel_grant.missing";
    const kind = factValue(decision, "channel.kind:");
    const treatment = factValue(decision, "channel.treatment:");
    if (kind !== undefined && treatment !== undefined) {
      return `channel_grant.${kind}.${treatment}`;
    }
  }
  if (decision.stage === "actor_identity") {
    return "actor is not authorized to create top-level inbound work";
  }
  return decision.reason;
}

export function requireRoutedDecision(decision: Ingress.RoutingDecisionPayload): AcceptedDecision {
  if (decision.outcome === "route") return decision;
  if (decision.stage === "blacklist" && decision.outcome === "drop") return decision;
  if (decision.outcome === "ambiguous") {
    throw new IngressRoutingError("route_ambiguous", decision.reason, decision);
  }
  throw new IngressRoutingError("route_blocked", terminalMessage(decision), decision);
}

export function pinRouteSession(
  event: Ingress.ResolvedInboundEvent,
  decision: AcceptedDecision,
): Ingress.ResolvedInboundEvent {
  if (decision.sessionId === undefined) return event;
  return {
    ...event,
    activation: {
      ...event.activation,
      durableSessionId: decision.sessionId,
    },
  };
}

export function pinSelectedTarget<Event extends Ingress.InboundEvent>(
  event: Event,
  target: Ingress.Target,
): Event {
  return { ...event, target };
}

function projectDispatchOutput(output: unknown, decision: RoutedDecision): string {
  if (typeof output === "string") return output;
  if (output === undefined || (typeof output === "object" && output !== null)) return "";
  const outputType = output === null ? "null" : typeof output;
  throw new IngressRoutingError(
    "dispatch_output_unsupported",
    `unsupported Command output for channel projection: type=${outputType}, value=${String(output)}`,
    decision,
  );
}

function projectWaitOwnerEvent<Event extends Ingress.InboundEvent>(
  event: Event,
  ownerSessionId: string,
): Omit<Event, "target"> & { readonly target?: never } {
  const { target: _target, ...withoutTarget } = event;
  const { target: _metaTarget, ...meta } = event.meta ?? {};
  const { runId: _runId, ...activation } = event.activation ?? {};
  return {
    ...withoutTarget,
    meta,
    activation: { ...activation, durableSessionId: ownerSessionId },
  } as Omit<Event, "target"> & { readonly target?: never };
}

function projectPendingAskEvent<Event extends Ingress.InboundEvent>(
  event: Event,
  resolution: Extract<KernelRouteResolution["waitExecution"], { kind: "pending_ask" }>,
): Omit<Event, "target"> & { readonly target?: never } {
  const { target: _target, ...withoutTarget } = event;
  const { target: _metaTarget, ...meta } = event.meta ?? {};
  const { runId: _runId, ...activation } = event.activation ?? {};
  const record = resolution.record;
  return {
    ...withoutTarget,
    meta: {
      ...meta,
      pendingAsk: {
        id: record.id,
        originSessionId: record.originSessionId,
        ...(record.originRunId === undefined ? {} : { originRunId: record.originRunId }),
        originActorKind: record.originActorKind,
        targetKind: record.targetKind,
        status: record.status,
        ambiguous: false,
      },
    },
    activation: {
      ...activation,
      durableSessionId: record.originSessionId,
      ...(record.originRunId === undefined ? {} : { runId: record.originRunId }),
    },
  } as Omit<Event, "target"> & { readonly target?: never };
}

// Sender matching is owned by wait/matcher.ts (the single core for ingress and
// dispatch); this module only converts its candidate count into the pinned
// dispatch_route_invalid rejection.
function senderMatchesPendingInteraction(
  event: Ingress.InboundEvent,
  wait: Extract<KernelRouteResolution["waitExecution"], { kind: "pending_interaction" }>,
): boolean {
  const candidates = Wait.responderCandidates(
    Wait.targetsOfPendingInteraction(wait.record),
    Wait.ingressEvidence(event, wait.correlation),
  );
  return candidates.length === 1;
}

async function executePendingInteractionRoute<Event extends Ingress.InboundEvent>(
  runtime: DispatchRuntime | undefined,
  trace: TraceContext.Type,
  resolution: KernelRouteResolution<Event>,
  decision: RoutedDecision,
): Promise<Ingress.IngressResult> {
  if (runtime === undefined) {
    throw new IngressRoutingError(
      "dispatch_runtime_missing",
      "dispatch runtime not configured",
      decision,
    );
  }
  // resolve-route is the only producer of wait_correlation route decisions and
  // copies target/session/run/interaction ids from the matched record, so those
  // fields are not re-compared here. Only the executable-action gate is ours:
  // resolve-route admits every allowed action, while this route can execute
  // report_result and ask_clarification alone.
  const wait = resolution.waitExecution;
  if (
    wait.kind !== "pending_interaction" ||
    (wait.requestedAction !== "report_result" && wait.requestedAction !== "ask_clarification")
  ) {
    throw new IngressRoutingError(
      "dispatch_route_invalid",
      "pending interaction route is incomplete",
      decision,
    );
  }

  const event = resolution.event;
  if (!senderMatchesPendingInteraction(event, wait)) {
    throw new IngressRoutingError(
      "dispatch_route_invalid",
      "pending interaction sender does not match the assigned actor endpoint",
      decision,
    );
  }
  const workspaceRoot = event.mode === "direct" ? event.agent.toolConfig?.workspaceRoot : undefined;
  const result = await submitPinnedPendingInteraction(
    runtime,
    Command.Input.parse({
      action: Command.Actions.ActorMessage,
      target: { kind: "surface", id: wait.correlation.channelId },
      payload: event.payload,
      correlation: wait.correlation,
    }),
    wait.record,
    {
      traceId: trace.traceId,
      actorKind: typeof event.meta?.actor?.actorId === "string" ? "human" : "unknown",
      actorId: event.meta?.actor?.actorId ?? wait.correlation.endpointId,
      sessionId: wait.record.sessionId,
      runId: wait.record.workerRunId,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    },
  );
  if (result.status !== "completed") {
    throw new IngressRoutingError(
      "dispatch_failed",
      result.reason ?? result.error ?? "pending interaction dispatch failed",
      decision,
    );
  }
  return {
    mode: event.mode,
    target: { kind: "worker", sessionId: wait.record.sessionId },
    sessionId: wait.record.sessionId,
    result: { output: projectDispatchOutput(result.output, decision), finishReason: "stop" },
  };
}

export type WaitRouteExecution<Event extends Ingress.InboundEvent = Ingress.InboundEvent> =
  | Readonly<{
      kind: "continue";
      event: Event | (Omit<Event, "target"> & { readonly target?: never });
      authority: "required" | "wait_precedence";
    }>
  | Readonly<{ kind: "handled"; result: Ingress.IngressResult }>;

export async function executeWaitRoute<Event extends Ingress.InboundEvent>(
  runtime: DispatchRuntime | undefined,
  trace: TraceContext.Type,
  resolution: KernelRouteResolution<Event>,
  decision: AcceptedDecision,
): Promise<WaitRouteExecution<Event>> {
  if (decision.stage === "blacklist" && decision.outcome === "drop") {
    return {
      kind: "handled",
      result: {
        kind: "dropped",
        mode: resolution.event.mode,
        target: resolution.selectedTarget,
        reason: decision.reason,
      },
    };
  }
  if (decision.outcome !== "route") {
    throw new TypeError("accepted terminal routing decision was not handled");
  }
  const wait = resolution.waitExecution;
  switch (wait.kind) {
    case "none":
      return { kind: "continue", event: resolution.event, authority: "required" };
    case "wait": {
      if (decision.stage !== "wait_correlation") {
        throw new IngressRoutingError(
          "dispatch_route_invalid",
          "wait route is incomplete",
          decision,
        );
      }
      // The matcher only returns candidates; the protocol fold decides
      // (duplicate / late / unknown / ambiguous / attach / resolve) and the
      // store persists the outcome before the owner session sees the reply.
      const at = Date.now();
      const outcome = WaitService.attachReply(
        wait.record.id,
        {
          replyKey: resolution.event.id,
          responderCandidates: Wait.responderCandidates(
            targetsOfWait(wait.record),
            Wait.ingressEvidence(resolution.event, wait.correlation),
          ),
          messageId: resolution.event.id,
          at,
        },
        trace.traceId,
      );
      if (outcome.kind === "rejected") {
        if (outcome.code === "deadline_passed") {
          // Lazy expiry: this late reply is the first observer of the passed
          // deadline — fold the wait to expired (recording partial progress)
          // before rejecting, so the ledger never keeps a dead open wait that
          // the boot sweep alone would have to find. A concurrent ingest may
          // have already folded the wait terminal (revision CAS conflict);
          // the expiry is an optimization, so it must never replace the typed
          // rejection below.
          try {
            WaitService.expire(wait.record.id, trace.traceId, at);
          } catch {
            // Already folded by a concurrent transition — the typed rejection
            // below is still the correct outcome for this reply.
          }
        }
        throw new IngressRoutingError(
          "wait_reply_rejected",
          `wait reply rejected: ${outcome.code}`,
          decision,
        );
      }
      // "already_resolved" (channel redelivery of the resolving reply) falls
      // through on purpose: the owner delivery repeats idempotently with the
      // recorded resolution — no state change, no revision bump.
      // resolve-route routed this decision, so the owner is a session
      // (workItem owners fail closed at the wait_correlation stage).
      return {
        kind: "continue",
        event: projectWaitOwnerEvent(resolution.event, wait.record.ownerRef.id),
        authority: "wait_precedence",
      };
    }
    case "pending_interaction":
      if (decision.stage !== "wait_correlation") {
        return { kind: "continue", event: resolution.event, authority: "required" };
      }
      return {
        kind: "handled",
        result: await executePendingInteractionRoute(runtime, trace, resolution, decision),
      };
    case "pending_ask":
      // resolve-route copies the resident target and origin session/run into the
      // decision from this same record; only the stage gate is checked here.
      if (decision.stage !== "wait_correlation") {
        throw new IngressRoutingError(
          "dispatch_route_invalid",
          "pending ask route is incomplete",
          decision,
        );
      }
      return {
        kind: "continue",
        event: projectPendingAskEvent(resolution.event, wait),
        authority: "wait_precedence",
      };
    case "ambiguous":
      throw new IngressRoutingError(
        "dispatch_route_invalid",
        "ambiguous wait cannot accompany a routed decision",
        decision,
      );
    default: {
      const unreachable: never = wait;
      throw new TypeError(`Unreachable wait execution: ${String(unreachable)}`);
    }
  }
}
