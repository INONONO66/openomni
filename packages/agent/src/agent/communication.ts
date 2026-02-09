/**
 * Agent communication type definitions
 */

import { randomUUID } from "crypto";

/**
 * Represents a message envelope for agent-to-agent communication
 * Aligned with spec section 2.6
 */
export interface MessageEnvelope<TPayload = unknown> {
  traceId: string;
  sessionId: string;
  runId: string;
  fromAgentId: string;
  toAgentId: string;
  sentAt: string; // ISO timestamp
  schemaRef: string;
  payload: TPayload;
}

/**
 * Configuration options for message delivery
 */
export interface DeliveryOptions {
  timeoutMs: number;
}

/**
 * Error class for messaging-related failures
 */
export class MessagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessagingError";
  }
}

export namespace AgentMessenger {
  const inboxes = new Map<string, MessageEnvelope[]>();
  const subscribers = new Map<
    string,
    ((envelope: MessageEnvelope) => void)[]
  >();

  const isValidEnvelope = (envelope: MessageEnvelope): boolean => {
    return Boolean(
      envelope.toAgentId &&
      envelope.fromAgentId &&
      envelope.payload !== undefined,
    );
  };

  export const send = async (envelope: MessageEnvelope): Promise<void> => {
    if (!isValidEnvelope(envelope)) {
      throw new MessagingError("Invalid message envelope");
    }

    const inbox = inboxes.get(envelope.toAgentId) ?? [];
    inbox.push(envelope);
    inboxes.set(envelope.toAgentId, inbox);

    const handlers = subscribers.get(envelope.toAgentId) ?? [];
    handlers.forEach((handler) => handler(envelope));
  };

  export const request = async (
    envelope: MessageEnvelope,
    options?: Partial<DeliveryOptions>,
  ): Promise<MessageEnvelope> => {
    const traceId = randomUUID();
    const requestEnvelope: MessageEnvelope = {
      ...envelope,
      traceId,
    };

    const timeoutMs = options?.timeoutMs ?? 5000;

    return new Promise<MessageEnvelope>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = subscribe(envelope.fromAgentId, (reply) => {
        if (reply.traceId !== traceId) {
          return;
        }

        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        unsubscribe();
        resolve(reply);
      });

      timeoutId = setTimeout(() => {
        unsubscribe();
        reject(new MessagingError("Request timed out"));
      }, timeoutMs);

      send(requestEnvelope).catch((error) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        unsubscribe();
        reject(error);
      });
    });
  };

  export const subscribe = (
    agentId: string,
    handler: (envelope: MessageEnvelope) => void,
  ): (() => void) => {
    const handlers = subscribers.get(agentId) ?? [];
    handlers.push(handler);
    subscribers.set(agentId, handlers);

    return () => {
      const existing = subscribers.get(agentId);
      if (!existing) {
        return;
      }
      const nextHandlers = existing.filter((item) => item !== handler);
      if (nextHandlers.length === 0) {
        subscribers.delete(agentId);
        return;
      }
      subscribers.set(agentId, nextHandlers);
    };
  };
}
