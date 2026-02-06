import { randomUUID } from "crypto";

/**
 * Event Envelope interface representing a standardized event structure
 */
export interface EventEnvelope {
  id: string;
  name: string;
  payload: unknown;
  timestamp: string; // ISO format
  traceId: string;
  source: string;
  metadata?: Record<string, unknown>;
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
export function normalize(input: Partial<EventEnvelope>): EventEnvelope {
  // Validate required fields
  if (!input.id) {
    throw new ValidationError("Missing required field: id");
  }
  if (!input.name) {
    throw new ValidationError("Missing required field: name");
  }
  if (!input.source) {
    throw new ValidationError("Missing required field: source");
  }

  // Generate traceId if not provided
  const traceId = input.traceId || randomUUID();

  // Convert timestamp to ISO string if number, otherwise use provided or current time
  let timestamp: string;
  if (typeof input.timestamp === "number") {
    timestamp = new Date(input.timestamp).toISOString();
  } else if (typeof input.timestamp === "string") {
    timestamp = input.timestamp;
  } else {
    timestamp = new Date().toISOString();
  }

  return {
    id: input.id,
    name: input.name,
    payload: input.payload ?? null,
    timestamp,
    traceId,
    source: input.source,
    metadata: input.metadata,
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
    source: string,
    payload?: unknown,
  ): EventEnvelope {
    return {
      id: randomUUID(),
      name,
      source,
      payload: payload ?? null,
      timestamp: new Date().toISOString(),
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
      typeof envelope.id === "string" &&
      envelope.id.length > 0 &&
      typeof envelope.name === "string" &&
      envelope.name.length > 0 &&
      typeof envelope.source === "string" &&
      envelope.source.length > 0 &&
      typeof envelope.timestamp === "string" &&
      envelope.timestamp.length > 0 &&
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
    const envelopeTime = new Date(envelope.timestamp).getTime();
    const currentTime = new Date().getTime();
    return currentTime - envelopeTime > maxAgeMs;
  }
}
