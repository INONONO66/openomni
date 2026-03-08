import { InboundEvent, Message } from "@openomni/protocol";
import { Session } from "@openomni/session";

// ============================================================
// IngressEventProjector
// ============================================================

/**
 * IngressEventProjector converts an InboundEvent into a UserMessage + TextPart
 * and stores both in the session.
 *
 * This fixes the legacy EventProjector bug where text payload was never stored.
 */
export namespace IngressEventProjector {
  /**
   * Extract text payload from an InboundEvent.
   * - If payload is a string → return it directly
   * - If payload is an object with a `text` field (string) → return that field
   * - Otherwise → JSON.stringify the payload
   */
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

  /**
   * Project an InboundEvent into a session as a UserMessage + TextPart.
   * @param event - The inbound event to project
   * @param sessionId - The session ID to add the message to
   */
  export function project(event: InboundEvent, sessionId: string): void {
    // Create UserMessage
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

    // Store UserMessage
    Session.addMessage(sessionId, message);

    // Create TextPart with extracted text payload
    const textPayload = extractTextPayload(event);
    const part: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: message.id,
      type: "text",
      text: textPayload,
    };

    // Store TextPart
    Session.addPart(message.id, part);
  }
}
