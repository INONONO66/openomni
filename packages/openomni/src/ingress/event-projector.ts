import type { Ingress, Message, TraceContext as TraceContextProtocol } from "@openomni/protocol";
import { Log, Session } from "@openomni/session";
import { createIngressLedger, summarizeText } from "./event-log-envelope";

export namespace IngressEventProjector {
  function extractTextPayload(event: Ingress.InboundEvent): string {
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
    event: Ingress.InboundEvent,
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

    const ledger = createIngressLedger(sessionId, "event_projector");
    const inboundEvent = ledger.append("ingress.inbound.project", {
      sessionId,
      eventId: event.id,
      mode: event.mode,
      source: event.surface,
      channel: event.channel,
      workspace: event.workspace,
      userId: event.userId,
      messageId: message.id,
      partId: part.id,
      role: message.role,
      text: summarizeText(textPayload),
    });
    const messageEvent = ledger.append(
      "ingress.inbound.message.write",
      {
        sessionId,
        eventId: event.id,
        mode: event.mode,
        source: event.surface,
        messageId: message.id,
        role: message.role,
      },
      inboundEvent?.actionId,
    );
    Session.addMessage(sessionId, message);

    ledger.append(
      "ingress.inbound.part.write",
      {
        sessionId,
        eventId: event.id,
        mode: event.mode,
        source: event.surface,
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
      Log.withContext({ traceId: traceContext.traceId }).info("message projected", { sessionId });
    }
  }
}
