import { Session } from "@openomni/session";
import { EventEnvelope } from "../loop";
import { Message } from "@openomni/protocol";

// ============================================================
// EventProjector Interface
// ============================================================

/**
 * EventProjector transforms an EventEnvelope into a Message and persists it to a session.
 * This interface enables custom event-to-message projection strategies.
 */
export interface EventProjector {
  /**
   * Project an event into a session as a message.
   * @param event - The event envelope to project
   * @param sessionId - The session ID to add the message to
   * @param defaultModel - Default model configuration for the message
   */
  project(
    event: EventEnvelope,
    sessionId: string,
    defaultModel: { providerID: string; modelID: string },
  ): void;
}

// ============================================================
// DefaultEventProjector
// ============================================================

/**
 * Default implementation of EventProjector.
 * Creates a UserMessage from the event and adds it to the session.
 */
export const DefaultEventProjector: EventProjector = {
  project(
    event: EventEnvelope,
    sessionId: string,
    defaultModel: { providerID: string; modelID: string },
  ): void {
    const message: Message.UserMessage = {
      id: event.eventId,
      sessionID: sessionId,
      role: "user",
      time: {
        created: new Date(event.receivedAt).getTime(),
      },
      agent: event.source.type,
      model: defaultModel,
    };

    Session.addMessage(sessionId, message);
  },
};
