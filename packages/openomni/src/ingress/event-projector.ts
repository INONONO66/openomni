import type { InboundEvent, Message } from "@openomni/protocol";
import { Session } from "@openomni/session";

export namespace IngressEventProjector {
  function extractTextPayload(event: InboundEvent): string {
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

  export function project(event: InboundEvent, sessionId: string): void {
    const message: Message.UserMessage = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      role: "user",
      time: {
        created: Date.now(),
      },
      agent: event.surface,
      // model is set by the caller after projection; undefined here is intentional
      // biome-ignore lint/suspicious/noExplicitAny: Message.UserMessage.model is required by protocol schema but not available at ingress time
      model: undefined as any,
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
  }
}
