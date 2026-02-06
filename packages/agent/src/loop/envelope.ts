import { randomUUID } from "crypto";

export type EventTrust = "trusted" | "untrusted";

export type EventPriority = "low" | "normal" | "high";

export interface EventSource {
  type: string;
  id?: string;
  trust?: EventTrust;
}

export interface EventEnvelope<TPayload = unknown> {
  eventId: string;
  name: string;
  source: EventSource;
  occurredAt: string;
  receivedAt: string;
  traceId: string;
  dedupeKey?: string;
  priority?: EventPriority;
  workspaceId?: string;
  userId?: string;
  schemaRef?: string;
  payload: TPayload;
  meta?: Record<string, unknown>;
}

/**
 * Normalized event type with standardized fields
 */
export type NormalizedEvent = EventEnvelope;

/**
 * Validation error class for envelope validation failures
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Normalizes a partial event envelope into a complete EventEnvelope
 * @param input - Partial event envelope to normalize
 * @returns Normalized EventEnvelope
 * @throws ValidationError if required fields are missing
 */
export function normalize(
  input: Partial<EventEnvelope> & {
    id?: string;
    timestamp?: string | number;
    source?: EventSource | string;
    metadata?: Record<string, unknown>;
  },
): EventEnvelope {
  const eventId = input.eventId ?? input.id;

  // Validate required fields
  if (!eventId) {
    throw new ValidationError("Missing required field: eventId");
  }
  if (!input.name) {
    throw new ValidationError("Missing required field: name");
  }
  if (!input.source) {
    throw new ValidationError("Missing required field: source");
  }

  // Generate traceId if not provided
  const traceId = input.traceId || randomUUID();

  const source: EventSource =
    typeof input.source === "string"
      ? { type: input.source }
      : {
          type: input.source.type,
          id: input.source.id,
          trust: input.source.trust,
        };

  let occurredAt: string;
  if (typeof input.occurredAt === "string") {
    occurredAt = input.occurredAt;
  } else if (typeof input.timestamp === "number") {
    occurredAt = new Date(input.timestamp).toISOString();
  } else if (typeof input.timestamp === "string") {
    occurredAt = input.timestamp;
  } else {
    occurredAt = new Date().toISOString();
  }

  const receivedAt = input.receivedAt ?? new Date().toISOString();

  return {
    eventId,
    name: input.name,
    source,
    occurredAt,
    receivedAt,
    traceId,
    dedupeKey: input.dedupeKey,
    priority: input.priority,
    workspaceId: input.workspaceId,
    userId: input.userId,
    schemaRef: input.schemaRef,
    payload: input.payload ?? null,
    meta: input.meta ?? input.metadata,
  };
}

/**
 * Envelope namespace providing utility functions for creating and validating event envelopes
 */
export namespace Envelope {
  /**
   * Creates a new EventEnvelope with generated id, traceId, and current timestamp
   * @param name - The name of the event
   * @param source - The source of the event
   * @param payload - Optional payload data
   * @returns A new EventEnvelope instance
   */
  export function create(
    name: string,
    source: string | EventSource,
    payload?: unknown,
  ): EventEnvelope {
    const now = new Date().toISOString();

    return {
      eventId: randomUUID(),
      name,
      source: typeof source === "string" ? { type: source } : source,
      payload: payload ?? null,
      occurredAt: now,
      receivedAt: now,
      traceId: randomUUID(),
    };
  }

  /**
   * Validates that an EventEnvelope has all required fields and they are valid
   * @param envelope - The envelope to validate
   * @returns true if envelope is valid, false otherwise
   */
  export function validate(envelope: EventEnvelope): boolean {
    return (
      typeof envelope.eventId === "string" &&
      envelope.eventId.length > 0 &&
      typeof envelope.name === "string" &&
      envelope.name.length > 0 &&
      typeof envelope.source?.type === "string" &&
      envelope.source.type.length > 0 &&
      typeof envelope.occurredAt === "string" &&
      envelope.occurredAt.length > 0 &&
      typeof envelope.receivedAt === "string" &&
      envelope.receivedAt.length > 0 &&
      typeof envelope.traceId === "string" &&
      envelope.traceId.length > 0
    );
  }

  /**
   * Checks if an EventEnvelope has expired based on its timestamp
   * @param envelope - The envelope to check
   * @param maxAgeMs - Maximum age in milliseconds
   * @returns true if envelope timestamp is older than maxAgeMs, false otherwise
   */
  export function isExpired(
    envelope: EventEnvelope,
    maxAgeMs: number,
  ): boolean {
    const envelopeTime = new Date(envelope.receivedAt).getTime();
    const currentTime = new Date().getTime();
    return currentTime - envelopeTime > maxAgeMs;
  }
}
