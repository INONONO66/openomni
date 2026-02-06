/**
 * Agent communication type definitions
 */

import { randomUUID } from "crypto";

/**
 * Represents a message envelope for agent-to-agent communication
 */
export interface MessageEnvelope {
  id: string;
  from: string;
  to: string;
  content: unknown;
  timestamp: number;
  correlationId: string;
  replyTo?: string;
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
      envelope.to && envelope.from && envelope.content !== undefined,
    );
  };

  export const send = async (envelope: MessageEnvelope): Promise<void> => {
    if (!isValidEnvelope(envelope)) {
      throw new MessagingError("Invalid message envelope");
    }

    const inbox = inboxes.get(envelope.to) ?? [];
    inbox.push(envelope);
    inboxes.set(envelope.to, inbox);

    const handlers = subscribers.get(envelope.to) ?? [];
    handlers.forEach((handler) => handler(envelope));
  };

  export const request = async (
    envelope: MessageEnvelope,
    options?: Partial<DeliveryOptions>,
  ): Promise<MessageEnvelope> => {
    const correlationId = randomUUID();
    const requestEnvelope: MessageEnvelope = {
      ...envelope,
      correlationId,
    };

    const timeoutMs = options?.timeoutMs ?? 5000;

    return new Promise<MessageEnvelope>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = subscribe(envelope.from, (reply) => {
        if (reply.correlationId !== correlationId) {
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
