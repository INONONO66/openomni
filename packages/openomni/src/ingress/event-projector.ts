import {
  type Ingress,
  Operational,
  type Message,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus, Session } from "@openomni/session";
import { createIngressAudit, summarizeText } from "./audit-envelope";
import { resolveTarget } from "./target";

export namespace IngressEventProjector {
  function extractTextPayload(event: Ingress.ResolvedInboundEvent): string {
    if (typeof event.payload === "string") {
      return event.payload;
    }

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

  export function project(
    event: Ingress.ResolvedInboundEvent,
    sessionId: string,
    model: { providerID: string; modelID: string },
    traceContext?: TraceContextProtocol.Type,
  ): void {
    const message: Message.UserMessage = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      role: "user",
      time: {
        created: Date.now(),
      },
      agent: event.surface,
      model,
    };

    const textPayload = extractTextPayload(event);
    const part: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: message.id,
      type: "text",
      text: textPayload,
    };

    const audit = createIngressAudit(sessionId, "event_projector");
    const inboundEvent = audit.append("ingress.inbound.project", {
      sessionId,
      eventId: event.id,
      mode: event.mode,
      source: event.surface,
      channel: event.channel,
      workspace: event.workspace,
      userId: event.userId,
      target: resolveTarget(event).kind,
      actor: event.meta?.actor,
      inboundTreatment: event.meta?.inboundTreatment,
      channelGrantId: event.meta?.channelGrantId,
      channelGrantKind: event.meta?.channelGrantKind,
      messageId: message.id,
      partId: part.id,
      role: message.role,
      text: summarizeText(textPayload),
    });
    const messageEvent = audit.append(
      "ingress.inbound.message.write",
      {
        sessionId,
        eventId: event.id,
        mode: event.mode,
        source: event.surface,
        target: resolveTarget(event).kind,
        inboundTreatment: event.meta?.inboundTreatment,
        channelGrantId: event.meta?.channelGrantId,
        channelGrantKind: event.meta?.channelGrantKind,
        messageId: message.id,
        role: message.role,
      },
      inboundEvent?.actionId,
    );
    Session.addMessage(sessionId, message);

    audit.append(
      "ingress.inbound.part.write",
      {
        sessionId,
        eventId: event.id,
        mode: event.mode,
        source: event.surface,
        target: resolveTarget(event).kind,
        inboundTreatment: event.meta?.inboundTreatment,
        channelGrantId: event.meta?.channelGrantId,
        channelGrantKind: event.meta?.channelGrantKind,
        messageId: message.id,
        partId: part.id,
        role: message.role,
        partType: part.type,
        text: summarizeText(textPayload),
      },
      messageEvent?.actionId,
    );
    Session.addPart(message.id, part);

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
