import { Command, Wait, type Ingress } from "@openomni/protocol";
import type { TraceContext } from "@openomni/protocol";
import { PendingInteractionStore } from "@openomni/ledger";
import { submitPinnedPendingInteraction, type DispatchRuntime } from "../dispatch/runtime.js";
import { IngressRoutingError } from "./internal-route.js";

/**
 * The pending-interaction delivery arm (#707 stage 2): the gateway router
 * correlates and records the route (its decision carries
 * `pendingInteractionId`); dispatch WORK PLACEMENT stays brain judgment
 * (kernel-contract §8.5, design §8.5), so this consumer re-anchors the frozen
 * row (a tolerated frozen-store read), re-derives the pure evidence from the
 * delivered event, and submits the pinned dispatch command. No session is
 * resolved and nothing is projected on this arm — exactly the pre-flip
 * behavior, where the pipeline returned before ingestResolved.
 */

type RoutedDecision = Extract<Ingress.RoutingDecisionPayload, { readonly outcome: "route" }>;

type ScopedCorrelation = Wait.Correlation & Readonly<{ endpointId: string; channelId: string }>;
const ScopedCorrelationClaim = Wait.Correlation.refine(
  (value): value is ScopedCorrelation =>
    value.endpointId !== undefined && value.channelId !== undefined,
  { message: "correlation claims require endpointId and channelId" },
);

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

// Sender matching is owned by the protocol matcher core (the single core for
// ingress and dispatch); this module only converts its candidate count into
// the pinned dispatch_route_invalid rejection.
function senderMatchesPendingInteraction(
  event: Ingress.ResolvedInboundEvent,
  record: PendingInteractionStore.Record,
  correlation: ScopedCorrelation,
): boolean {
  const candidates = Wait.responderCandidates(
    Wait.targetsOfPendingInteraction(record),
    Wait.ingressEvidence(event, correlation),
  );
  return candidates.length === 1;
}

export async function executePendingInteractionDelivery(
  runtime: DispatchRuntime | undefined,
  trace: TraceContext.Type,
  event: Ingress.ResolvedInboundEvent,
  decision: RoutedDecision,
): Promise<Ingress.IngressResult> {
  if (runtime === undefined) {
    throw new IngressRoutingError(
      "dispatch_runtime_missing",
      "dispatch runtime not configured",
      decision,
    );
  }
  // The router is the only producer of pending-interaction deliveries and
  // copies target/session/run/interaction ids from the matched record into
  // the recorded decision. Only the executable-action gate is ours: routing
  // admits every allowed action, while this arm can execute report_result
  // and ask_clarification alone.
  const requestedAction = Wait.requestedWaitAction(event.payload);
  const record =
    decision.pendingInteractionId === undefined
      ? undefined
      : PendingInteractionStore.get(decision.pendingInteractionId);
  const rawCorrelation = event.meta?.correlation;
  const correlation =
    rawCorrelation === undefined ? undefined : ScopedCorrelationClaim.parse(rawCorrelation);
  if (
    record === undefined ||
    correlation === undefined ||
    (requestedAction !== "report_result" && requestedAction !== "ask_clarification")
  ) {
    throw new IngressRoutingError(
      "dispatch_route_invalid",
      "pending interaction route is incomplete",
      decision,
    );
  }

  if (!senderMatchesPendingInteraction(event, record, correlation)) {
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
      target: { kind: "surface", id: correlation.channelId },
      payload: event.payload,
      correlation,
    }),
    record,
    {
      traceId: trace.traceId,
      actorKind: typeof event.meta?.actor?.actorId === "string" ? "human" : "unknown",
      actorId: event.meta?.actor?.actorId ?? correlation.endpointId,
      sessionId: record.sessionId,
      runId: record.workerRunId,
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
    target: { kind: "worker", sessionId: record.sessionId },
    sessionId: record.sessionId,
    result: { output: projectDispatchOutput(result.output, decision), finishReason: "stop" },
  };
}
