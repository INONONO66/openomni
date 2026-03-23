import { z } from "zod";

export namespace Messenger {
  /**
   * Persistence policy for message storage
   * - asker_only: Only the sender can view the full message
   * - both: Both sender and receiver can view the full message
   */
  export const PersistencePolicy = z.enum(["asker_only", "both"]);
  export type PersistencePolicy = z.infer<typeof PersistencePolicy>;

  /**
   * Authorization pattern for agent-to-agent communication
   * Supports wildcard "*" for from/to fields
   */
  export const AllowPattern = z.object({
    from: z.string().describe("Source agent ID or '*' for any"),
    to: z.string().describe("Target agent ID or '*' for any"),
  });
  export type AllowPattern = z.infer<typeof AllowPattern>;

  /**
   * Message envelope for agent-to-agent communication
   * Zod schema for validation; use MessageEnvelope<T> type for generic payload
   */
  export const MessageEnvelopeSchema = z.object({
    id: z.string().describe("Unique message ID"),
    traceId: z.string().describe("Trace ID for distributed tracing"),
    correlationId: z
      .string()
      .nullable()
      .describe("Correlation ID for request/response pairing"),
    sessionId: z.string().describe("Session ID"),
    runId: z.string().describe("Run ID"),
    fromAgentId: z.string().describe("Sender agent ID"),
    toAgentId: z.string().describe("Recipient agent ID"),
    sentAt: z.string().describe("ISO 8601 timestamp"),
    schemaRef: z.string().describe("Schema reference for payload validation"),
    payload: z.unknown().describe("Message payload (type-specific)"),
    persistencePolicy: PersistencePolicy.describe("Storage and access policy"),
  });

  /**
   * Generic MessageEnvelope type
   * Use this for typed payload access; Zod doesn't support generics
   */
  export type MessageEnvelope<T = unknown> = Omit<
    z.infer<typeof MessageEnvelopeSchema>,
    "payload"
  > & {
    payload: T;
  };

  /**
   * Audit entry for message operations
   * Read-only record of agent actions on messages
   */
  export const AuditEntry = z.object({
    id: z.string().describe("Audit entry ID"),
    envelopeId: z.string().describe("Message envelope ID"),
    agentId: z.string().describe("Agent performing the action"),
    action: z.string().describe("Action performed (e.g., 'send', 'receive')"),
    timestamp: z.string().describe("ISO 8601 timestamp"),
  });
  export type AuditEntry = z.infer<typeof AuditEntry>;
}
