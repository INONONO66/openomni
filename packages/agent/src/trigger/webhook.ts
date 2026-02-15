import { EventEnvelope, Envelope } from "../loop";

/**
 * Configuration for webhook watchers
 */
export interface WebhookConfig {
  eventName: string;
  sourceType: string;
  fieldMapping?: Record<string, string>;
}

/**
 * Abstract base class for webhook watchers
 * Subclasses implement onPayload() to transform incoming webhook payloads into EventEnvelopes
 */
export abstract class WebhookWatcher {
  protected config: WebhookConfig;

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  /**
   * Abstract method to transform a webhook payload into an EventEnvelope
   * Subclasses must implement this to define their specific transformation logic
   * @param payload - The incoming webhook payload
   * @returns EventEnvelope if payload is valid, null if payload cannot be transformed
   */
  abstract onPayload(payload: unknown): EventEnvelope | null;

  /**
   * Public method to receive and validate a webhook payload
   * Calls onPayload() and validates the result
   * @param payload - The incoming webhook payload
   * @returns Valid EventEnvelope if payload is valid, null otherwise
   */
  receive(payload: unknown): EventEnvelope | null {
    const envelope = this.onPayload(payload);

    // Validate the envelope
    if (envelope === null) {
      return null;
    }

    if (!Envelope.validate(envelope)) {
      return null;
    }

    return envelope;
  }
}

/**
 * Simple webhook watcher that maps payload fields to EventEnvelope using configurable field mapping
 */
export class SimpleWebhookWatcher extends WebhookWatcher {
  /**
   * Transform a webhook payload into an EventEnvelope using field mapping
   * @param payload - The incoming webhook payload (should be an object)
   * @returns EventEnvelope if payload is valid, null otherwise
   */
  onPayload(payload: unknown): EventEnvelope | null {
    // Validate payload is an object
    if (typeof payload !== "object" || payload === null) {
      return null;
    }

    const payloadObj = payload as Record<string, unknown>;

    // Extract fields using mapping, or use defaults
    const fieldMapping = this.config.fieldMapping || {};

    // Get the event ID (required)
    const eventIdField = fieldMapping["eventId"] || "id";
    const eventId = payloadObj[eventIdField];
    if (typeof eventId !== "string" || !eventId) {
      return null;
    }

    // Get the timestamp (optional, defaults to now)
    const timestampField = fieldMapping["timestamp"] || "timestamp";
    let occurredAt: string;
    const timestamp = payloadObj[timestampField];
    if (typeof timestamp === "number") {
      occurredAt = new Date(timestamp).toISOString();
    } else if (typeof timestamp === "string") {
      occurredAt = timestamp;
    } else {
      occurredAt = new Date().toISOString();
    }

    // Get the source ID (optional)
    const sourceIdField = fieldMapping["sourceId"] || "sourceId";
    const sourceId = payloadObj[sourceIdField];

    // Create the envelope with the extracted eventId
    const envelope = Envelope.create(
      this.config.eventName,
      {
        type: this.config.sourceType,
        id: typeof sourceId === "string" ? sourceId : undefined,
      },
      payloadObj,
    );

    // Override eventId and occurredAt with the mapped values
    envelope.eventId = eventId;
    envelope.occurredAt = occurredAt;

    return envelope;
  }
}
