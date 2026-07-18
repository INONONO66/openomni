import { Dispatch, type Ingress, type RoutingDecisionPayload } from "@openomni/protocol";
import type { TraceContext } from "@openomni/protocol";
import { submitPinnedPendingInteraction, type DispatchRuntime } from "../dispatch/runtime.js";
import type { KernelRouteResolution } from "./routing-runtime.js";

type RoutedDecision = Extract<RoutingDecisionPayload, { readonly outcome: "route" }>;

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

export function requireRoutedDecision(decision: RoutingDecisionPayload): RoutedDecision {
  if (decision.outcome === "route") return decision;
  if (decision.outcome === "ambiguous") {
    throw new IngressRoutingError("route_ambiguous", decision.reason, decision);
  }
  throw new IngressRoutingError("route_blocked", terminalMessage(decision), decision);
}

export function pinRouteSession(
  event: Ingress.ResolvedInboundEvent,
  decision: RoutedDecision,
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
    runtime: {
      ...runtime,
      durableSessionId: record.originSessionId,
      ...(record.originRunId === undefined ? {} : { runId: record.originRunId }),
    },
  } as Omit<Event, "target"> & { readonly target?: never };
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
  if (
    wait.kind !== "pending_interaction" ||
    decision.stage !== "wait_correlation" ||
    decision.target !== `worker-session:${wait.record.sessionId}` ||
    decision.sessionId !== wait.record.sessionId ||
    decision.runId !== wait.record.workerRunId ||
    decision.pendingInteractionId !== wait.record.id ||
    !wait.record.allowedActions.includes(wait.requestedAction)
  ) {
    throw new IngressRoutingError(
      "dispatch_route_invalid",
      "pending interaction route is incomplete",
      decision,
    );
  }

  const event = resolution.event;
  const workspaceRoot = event.mode === "direct" ? event.agent.toolConfig?.workspaceRoot : undefined;
  const result = await submitPinnedPendingInteraction(
    runtime,
    Dispatch.Input.parse({
      action: Dispatch.Actions.ActorMessage,
      target: { kind: "surface", id: wait.correlation.channelId },
      payload: event.payload,
      correlation: wait.correlation,
    }),
    wait.record,
    {
      traceId: trace.traceId,
      actorKind: "unknown",
      actorId: wait.correlation.endpointId,
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
    target: { kind: "worker", sessionId: decision.sessionId },
    sessionId: decision.sessionId,
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
  decision: RoutedDecision,
): Promise<WaitRouteExecution<Event>> {
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
        decision.sessionId !== wait.record.originSessionId ||
        decision.runId !== wait.record.originRunId
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
