import { createHash } from "node:crypto";
import {
  type Ingress,
  Operational,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus } from "@openomni/session";
import {
  type IngressModelConfig,
  type ResidentEffectOutcome,
  type ResidentIngressReceipt,
  requireCommittedMessagingTransition,
  requireIngressModel,
  requireMessagingLedgerService,
} from "./session-resolver";

export namespace IngressEventProjector {
  function extractTextPayload(event: Ingress.ResolvedInboundEvent): string {
    if (typeof event.payload === "string") return event.payload;

    if (
      typeof event.payload === "object" &&
      event.payload !== null &&
      "text" in event.payload &&
      typeof (event.payload as Record<string, unknown>).text === "string"
    ) {
      return (event.payload as Record<string, unknown>).text as string;
    }

    return JSON.stringify(event.payload) ?? "";
  }

  function deliveryId(eventId: string, kind: string): string {
    if (eventId.length === 0) {
      throw new TypeError("authenticated delivery identity is required");
    }
    const digest = createHash("sha256").update(`ingress:${kind}:${eventId}`).digest("hex");
    return `${kind}:${digest}`;
  }

  function recordedAt(eventId: string): number {
    const digest = createHash("sha256").update(`ingress:time:${eventId}`).digest("hex");
    return Number.parseInt(digest.slice(0, 12), 16);
  }

  function requireResidentReceipt(
    result: ReturnType<typeof requireCommittedMessagingTransition>,
  ): ResidentIngressReceipt {
    if (result.residentReceipt === undefined) {
      throw new TypeError("Resident ingress transition omitted its durable receipt");
    }
    return result.residentReceipt;
  }

  export async function projectResident(
    event: Ingress.ResolvedInboundEvent,
    surfaceKey: string,
    model: IngressModelConfig,
    traceContext?: TraceContextProtocol.Type,
  ): Promise<ResidentIngressReceipt> {
    const service = requireMessagingLedgerService();
    const validatedModel = requireIngressModel(model, traceContext);
    const binding = await service.query({ kind: "surface", surfaceKey });
    if (binding.kind !== "surface") throw new TypeError("Invalid surface projection");

    const requestId = deliveryId(event.id, "resident-request");
    const messageId = deliveryId(event.id, "message");
    const proposedSessionId = deliveryId(event.id, "session");
    const authoritativeSessionId = event.runtime?.durableSessionId ?? binding.sessionId;
    const command = {
      kind:
        authoritativeSessionId === undefined ||
        authoritativeSessionId === null ||
        authoritativeSessionId === proposedSessionId
          ? ("RT-12" as const)
          : ("RT-11" as const),
      requestId,
      surfaceKey,
      sessionId: authoritativeSessionId ?? proposedSessionId,
      event,
      messageId,
      partId: deliveryId(event.id, "part"),
      effectId: deliveryId(event.id, "resident-effect"),
      text: extractTextPayload(event),
      title: `Session from ${event.surface}`,
      model: validatedModel,
      recordedAt: recordedAt(event.id),
    };
    let result = await service.execute(command);

    // Another delivery may have won the first-contact bind. Re-read the authoritative binding and
    // record against that durable session rather than issuing a conflicting second first-contact.
    if (
      result.status === "rejected" &&
      result.code === "head_conflict" &&
      command.kind === "RT-12"
    ) {
      const rebound = await service.query({ kind: "surface", surfaceKey });
      if (rebound.kind !== "surface" || rebound.sessionId === null) {
        return requireResidentReceipt(requireCommittedMessagingTransition(result));
      }
      result = await service.execute({ ...command, kind: "RT-11", sessionId: rebound.sessionId });
    }

    const receipt = requireResidentReceipt(requireCommittedMessagingTransition(result));
    if (traceContext) {
      Bus.publish(Operational.Info, {
        traceId: traceContext.traceId,
        time: Date.now(),
        sessionId: receipt.sessionId,
        component: "ingress.projector",
        msg: "resident ingress batch committed",
      });
    }
    return receipt;
  }

  export async function settleResident(
    receipt: ResidentIngressReceipt,
    sourceRef: string,
    outcome: ResidentEffectOutcome,
  ): Promise<void> {
    const kind =
      outcome.status === "confirmed"
        ? "EF-01"
        : outcome.status === "definite_failed"
          ? "EF-02"
          : "EF-03";
    requireCommittedMessagingTransition(
      await requireMessagingLedgerService().execute({
        kind,
        requestId: deliveryId(sourceRef, `resident-settlement:${outcome.status}`),
        sessionId: receipt.sessionId,
        effectId: receipt.effectId,
        sourceRef,
        outcome,
        settledAt: recordedAt(`${sourceRef}:${outcome.status}`),
      }),
    );
  }

  export async function projectResidentResult(
    eventId: string,
    sessionId: string,
    text: string,
    model: { readonly provider: string; readonly id: string },
  ): Promise<void> {
    requireCommittedMessagingTransition(
      await requireMessagingLedgerService().execute({
        kind: "MS-06",
        sessionId,
        messageId: deliveryId(eventId, "assistant-message"),
        partId: deliveryId(eventId, "assistant-part"),
        role: "assistant",
        text,
        model,
        agent: "resident",
        recordedAt: recordedAt(`${eventId}:assistant`),
      }),
    );
  }

  export async function project(
    event: Ingress.ResolvedInboundEvent,
    sessionId: string,
    model: { providerID: string; modelID: string },
    traceContext?: TraceContextProtocol.Type,
  ): Promise<void> {
    const text = extractTextPayload(event);
    requireCommittedMessagingTransition(
      await requireMessagingLedgerService().execute({
        kind: "MS-01",
        sessionId,
        event,
        messageId: deliveryId(event.id, "message"),
        partId: deliveryId(event.id, "part"),
        text,
        model,
        recordedAt: recordedAt(event.id),
      }),
    );

    if (traceContext) {
      Bus.publish(Operational.Info, {
        traceId: traceContext.traceId,
        time: Date.now(),
        sessionId,
        component: "ingress.projector",
        msg: "message projected",
      });
    }
  }
}
