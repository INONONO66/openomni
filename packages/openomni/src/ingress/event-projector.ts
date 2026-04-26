import type { Ingress, Message, TraceContext as TraceContextProtocol } from "@openomni/protocol";
import { Log, Session } from "@openomni/session";

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

    Session.addMessage(sessionId, message);

    const textPayload = extractTextPayload(event);
    const part: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: message.id,
      type: "text",
      text: textPayload,
    };

    Session.addPart(message.id, part);

    if (traceContext) {
      Log.withContext({ traceId: traceContext.traceId }).info("message projected", { sessionId });
    }
  }
}
