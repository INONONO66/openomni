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
      model: undefined as any, // Will be set by caller if needed
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
