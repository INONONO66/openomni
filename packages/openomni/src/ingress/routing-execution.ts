import { Dispatch, type Ingress, type RoutingDecisionPayload } from "@openomni/protocol";
import type { TraceContext } from "@openomni/protocol";
import { submitPinnedPendingInteraction, type DispatchRuntime } from "../dispatch/runtime.js";
import type { KernelRouteResolution } from "./routing-runtime.js";

type RoutedDecision = Extract<RoutingDecisionPayload, { readonly outcome: "route" }>;

type BlacklistDropDecision = Extract<
  RoutingDecisionPayload,
  { readonly stage: "blacklist"; readonly outcome: "drop" }
>;
type AcceptedDecision = RoutedDecision | BlacklistDropDecision;

export type IngressRoutingErrorCode =
  | "route_blocked"
  | "route_ambiguous"
  | "dispatch_runtime_missing"
  | "dispatch_route_invalid"
  | "dispatch_failed"
  | "dispatch_output_unsupported";

export class IngressRoutingError extends Error {
  readonly code: IngressRoutingErrorCode;
  readonly decision: RoutingDecisionPayload;

  constructor(code: IngressRoutingErrorCode, message: string, decision: RoutingDecisionPayload) {
    super(message);
    this.name = "IngressRoutingError";
    this.code = code;
    this.decision = decision;
  }
}

function factValue(decision: RoutingDecisionPayload, prefix: string): string | undefined {
  const fact = decision.factsUsed.find((candidate) => candidate.startsWith(prefix));
  return fact?.slice(prefix.length);
}

function terminalMessage(decision: RoutingDecisionPayload): string {
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

export function requireRoutedDecision(decision: RoutingDecisionPayload): AcceptedDecision {
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
    runtime: {
      ...event.runtime,
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
    `unsupported Dispatch output for channel projection: type=${outputType}, value=${String(output)}`,
    decision,
  );
}

function projectPendingAskEvent<Event extends Ingress.InboundEvent>(
  event: Event,
  resolution: Extract<KernelRouteResolution["waitExecution"], { kind: "pending_ask" }>,
): Omit<Event, "target"> & { readonly target?: never } {
  const { target: _target, ...withoutTarget } = event;
  const { target: _metaTarget, ...meta } = event.meta ?? {};
  const { runId: _runId, ...runtime } = event.runtime ?? {};
  const wait = resolution.wait;
  return {
    ...withoutTarget,
    meta: {
      ...meta,
      pendingAsk: {
        id: wait.waitId,
        originSessionId: wait.route.sessionId,
        ...(wait.route.runId === undefined ? {} : { originRunId: wait.route.runId }),
        originActorKind: wait.opened.ownerRef.kind === "workItem" ? "worker" : "resident",
        targetKind: wait.opened.endpointId === undefined ? "resident" : "external_actor",
        status: wait.status,
        ambiguous: false,
      },
    },
    runtime: {
      ...runtime,
      durableSessionId: wait.route.sessionId,
      ...(wait.route.runId === undefined ? {} : { runId: wait.route.runId }),
    },
  } as Omit<Event, "target"> & { readonly target?: never };
}

function hasMatchingBearerToken(
  correlation: Dispatch.Correlation,
  wait: Extract<KernelRouteResolution["waitExecution"], { kind: "pending_interaction" }>["wait"],
): boolean {
  return (
    wait.opened.targetActorId === undefined &&
    wait.opened.correlation.tokenHash !== undefined &&
    correlation.tokenHash === wait.opened.correlation.tokenHash
  );
}

function senderMatchesPendingInteraction(
  event: Ingress.InboundEvent,
  wait: Extract<KernelRouteResolution["waitExecution"], { kind: "pending_interaction" }>,
): boolean {
  if (hasMatchingBearerToken(wait.correlation, wait.wait)) return true;
  if (wait.correlation.endpointId !== wait.wait.opened.endpointId) return false;

  if (
    wait.wait.opened.targetActorId !== undefined &&
    typeof event.meta?.actor?.actorId !== "string"
  ) {
    return false;
  }
  const actor = event.meta?.actor;
  if (typeof actor?.actorId !== "string") {
    if (event.mode !== "direct" || typeof event.userId !== "string") return false;
    return (
      event.userId === wait.wait.opened.endpointId ||
      wait.wait.opened.endpointId?.endsWith(`:${event.userId}`) === true
    );
  }
  if (
    wait.wait.opened.targetActorId !== undefined &&
    actor.actorId !== wait.wait.opened.targetActorId
  ) {
    return false;
  }

  const endpoint = actor.endpoint;
  if (endpoint === undefined) return actor.endpointId === wait.wait.opened.endpointId;
  return (
    endpoint.id === wait.wait.opened.endpointId ||
    endpoint.externalId === wait.wait.opened.endpointId ||
    `${endpoint.channel}:${endpoint.externalId}` === wait.wait.opened.endpointId
  );
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
  const wait = resolution.waitExecution;
  const executableAction =
    wait.kind === "pending_interaction" &&
    (wait.requestedAction === "report_result" || wait.requestedAction === "ask_clarification");
  if (
    !executableAction ||
    wait.kind !== "pending_interaction" ||
    decision.stage !== "wait_correlation" ||
    decision.target !== `worker-session:${wait.wait.route.sessionId}` ||
    decision.sessionId !== wait.wait.route.sessionId ||
    decision.runId !== wait.wait.route.runId ||
    decision.pendingInteractionId !== wait.wait.waitId ||
    !wait.wait.opened.allowedActions.includes(wait.requestedAction)
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
  const routedAction =
    wait.requestedAction === "report_result"
      ? Dispatch.Actions.WorkerComplete
      : Dispatch.Actions.ResidentAsk;
  if (runtime.registry.get(routedAction) === undefined) {
    throw new IngressRoutingError(
      "dispatch_failed",
      `No dispatch handler registered for ${routedAction}`,
      decision,
    );
  }
  const workspaceRoot = event.mode === "direct" ? event.agent.toolConfig?.workspaceRoot : undefined;
  const result = await submitPinnedPendingInteraction(
    runtime,
    Dispatch.Input.parse({
      action: Dispatch.Actions.ActorMessage,
      target: { kind: "surface", id: wait.correlation.channelId },
      payload: event.payload,
      correlation: wait.correlation,
    }),
    wait.wait,
    {
      traceId: trace.traceId,
      actorKind: typeof event.meta?.actor?.actorId === "string" ? "user" : "unknown",
      actorId: event.meta?.actor?.actorId ?? wait.correlation.endpointId,
      sessionId: wait.wait.route.sessionId,
      runId: wait.wait.route.runId,
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
    target: { kind: "worker", sessionId: wait.wait.route.sessionId },
    sessionId: wait.wait.route.sessionId,
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
    case "pending_interaction":
      if (decision.stage !== "wait_correlation") {
        return { kind: "continue", event: resolution.event, authority: "required" };
      }
      return {
        kind: "handled",
        result: await executePendingInteractionRoute(runtime, trace, resolution, decision),
      };
    case "pending_ask":
      if (
        decision.stage !== "wait_correlation" ||
        decision.target !== "resident" ||
        decision.sessionId !== wait.wait.route.sessionId ||
        decision.runId !== wait.wait.route.runId
      ) {
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
