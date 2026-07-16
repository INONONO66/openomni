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
  | "dispatch_failed";

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

function outputText(output: unknown): string {
  return typeof output === "string" ? output : "";
}

export async function executePendingInteractionRoute(
  runtime: DispatchRuntime | undefined,
  event: Ingress.InboundEvent,
  trace: TraceContext.Type,
  resolution: KernelRouteResolution,
  decision: RoutedDecision,
): Promise<Ingress.IngressResult> {
  if (runtime === undefined) {
    throw new IngressRoutingError(
      "dispatch_runtime_missing",
      "dispatch runtime not configured",
      decision,
    );
  }
  const pendingInteraction = resolution.pendingInteraction;
  const correlation = resolution.correlation;
  const workspaceRoot = event.mode === "direct" ? event.agent.toolConfig?.workspaceRoot : undefined;
  if (
    decision.stage !== "wait_correlation" ||
    pendingInteraction === undefined ||
    correlation === undefined ||
    decision.sessionId === undefined
  ) {
    throw new IngressRoutingError(
      "dispatch_route_invalid",
      "pending interaction route is incomplete",
      decision,
    );
  }

  const result = await submitPinnedPendingInteraction(
    runtime,
    Dispatch.Input.parse({
      action: Dispatch.Actions.ActorMessage,
      target: { kind: "surface", id: correlation.channelId },
      payload: event.payload,
      correlation,
    }),
    pendingInteraction,
    {
      traceId: trace.traceId,
      actorKind: "unknown",
      actorId: correlation.endpointId,
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
    result: { output: outputText(result.output), finishReason: "stop" },
  };
}
