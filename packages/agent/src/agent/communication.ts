/**
 * Agent communication type definitions
 */

import { randomUUID } from "crypto";

/**
 * Persistence policy for A2A message exchanges
 * - "asker_only": Content persisted only in requester session
 * - "both": Content persisted in both requester and responder sessions
 * - "none": No persistence (audit metadata only)
 */
export type PersistencePolicy = "asker_only" | "both" | "none";

/**
 * Audit metadata for A2A message exchanges
 * Lightweight tracking for operability without full payload storage
 */
export interface AuditMetadata {
  traceId: string;
  fromAgentId: string;
  toAgentId: string;
  direction: "request" | "response";
  timestamp: string; // ISO 8601
  status: "sent" | "delivered" | "failed";
  latencyMs?: number;
}

/**
 * Audit entry combining metadata with minimal envelope info
 * Does NOT include payload to support selective persistence
 */
export type AuditEntry = AuditMetadata & {
  messageId: string;
  type: string;
};

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
  persistencePolicy?: PersistencePolicy;
}

/**
 * Allow pattern for A2A communication authorization.
 * Supports exact agent IDs or "*" wildcard for any agent.
 */
export interface AllowPattern {
  from: string;
  to: string;
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
  const auditLogs = new Map<string, AuditEntry[]>();
  const subscribers = new Map<
    string,
    ((envelope: MessageEnvelope) => void)[]
  >();
  let allowPatterns: AllowPattern[] | null = null;
  let bothPolicyEnabled = false;

  const isValidEnvelope = (envelope: MessageEnvelope): boolean => {
    return Boolean(
      envelope.toAgentId &&
      envelope.fromAgentId &&
      envelope.payload !== undefined,
    );
  };

  const isAllowed = (from: string, to: string): boolean => {
    if (allowPatterns === null) return true;
    return allowPatterns.some(
      (p) =>
        (p.from === "*" || p.from === from) && (p.to === "*" || p.to === to),
    );
  };

  export const configureAllowPatterns = (patterns: AllowPattern[]): void => {
    allowPatterns = [...patterns];
  };

  export const resetAllowPatterns = (): void => {
    allowPatterns = null;
  };

  export const enableBothPolicy = (): void => {
    bothPolicyEnabled = true;
  };

  export const resetBothPolicy = (): void => {
    bothPolicyEnabled = false;
  };

  const createAuditEntry = (envelope: MessageEnvelope): AuditEntry => {
    return {
      messageId: envelope.runId,
      type: envelope.schemaRef,
      traceId: envelope.traceId,
      fromAgentId: envelope.fromAgentId,
      toAgentId: envelope.toAgentId,
      direction: "request",
      timestamp: envelope.sentAt,
      status: "delivered",
    };
  };

  export const send = async (envelope: MessageEnvelope): Promise<void> => {
    if (!isValidEnvelope(envelope)) {
      throw new MessagingError("Invalid message envelope");
    }

    if (!isAllowed(envelope.fromAgentId, envelope.toAgentId)) {
      const failedEntry = createAuditEntry(envelope);
      failedEntry.status = "failed";

      const fromAudit = auditLogs.get(envelope.fromAgentId) ?? [];
      fromAudit.push(failedEntry);
      auditLogs.set(envelope.fromAgentId, fromAudit);

      const toAudit = auditLogs.get(envelope.toAgentId) ?? [];
      toAudit.push(failedEntry);
      auditLogs.set(envelope.toAgentId, toAudit);

      throw new MessagingError(
        `Unauthorized: ${envelope.fromAgentId} -> ${envelope.toAgentId} not allowed`,
      );
    }

    const policy = envelope.persistencePolicy ?? "asker_only";

    if (policy === "both" && !bothPolicyEnabled) {
      const failedEntry = createAuditEntry(envelope);
      failedEntry.status = "failed";

      const fromAudit = auditLogs.get(envelope.fromAgentId) ?? [];
      fromAudit.push(failedEntry);
      auditLogs.set(envelope.fromAgentId, fromAudit);

      const toAudit = auditLogs.get(envelope.toAgentId) ?? [];
      toAudit.push(failedEntry);
      auditLogs.set(envelope.toAgentId, toAudit);

      throw new MessagingError(
        'Persistence policy "both" requires explicit opt-in via enableBothPolicy()',
      );
    }

    // Store in sender (fromAgentId) inbox based on policy
    if (policy === "asker_only" || policy === "both") {
      const senderInbox = inboxes.get(envelope.fromAgentId) ?? [];
      senderInbox.push(envelope);
      inboxes.set(envelope.fromAgentId, senderInbox);
    } else if (policy === "none") {
      const senderAudit = auditLogs.get(envelope.fromAgentId) ?? [];
      senderAudit.push(createAuditEntry(envelope));
      auditLogs.set(envelope.fromAgentId, senderAudit);
    }

    // Store in receiver (toAgentId) inbox based on policy
    if (policy === "both") {
      const receiverInbox = inboxes.get(envelope.toAgentId) ?? [];
      receiverInbox.push(envelope);
      inboxes.set(envelope.toAgentId, receiverInbox);
    } else {
      // asker_only or none: store audit entry only
      const receiverAudit = auditLogs.get(envelope.toAgentId) ?? [];
      receiverAudit.push(createAuditEntry(envelope));
      auditLogs.set(envelope.toAgentId, receiverAudit);
    }

    // Subscribers always get full envelope (notification behavior unchanged)
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

  export const getAuditLog = (agentId: string): AuditEntry[] => {
    return auditLogs.get(agentId) ?? [];
  };
}
