/// <reference types="bun" />
import { describe, it, expect } from "bun:test";
import {
  WebhookWatcher,
  SimpleWebhookWatcher,
  type WebhookConfig,
} from "../../../src/legacy/trigger/webhook";
import { EventEnvelope } from "../../../src/legacy/dispatch/envelope";

describe("WebhookWatcher", () => {
  describe("SimpleWebhookWatcher", () => {
    it("transforms valid payload to EventEnvelope", () => {
      const config: WebhookConfig = {
        eventName: "webhook.received",
        sourceType: "webhook",
      };

      const watcher = new SimpleWebhookWatcher(config);
      const payload = {
        id: "evt-123",
        timestamp: 1704067200000,
        data: "test",
      };

      const envelope = watcher.receive(payload);

      expect(envelope).not.toBeNull();
      expect(envelope?.eventId).toBe("evt-123");
      expect(envelope?.name).toBe("webhook.received");
      expect(envelope?.source.type).toBe("webhook");
      expect(envelope?.payload).toEqual(payload);
    });

    it("returns null for non-object payload", () => {
      const config: WebhookConfig = {
        eventName: "webhook.received",
        sourceType: "webhook",
      };

      const watcher = new SimpleWebhookWatcher(config);

      expect(watcher.receive("string")).toBeNull();
      expect(watcher.receive(123)).toBeNull();
      expect(watcher.receive(null)).toBeNull();
      expect(watcher.receive(undefined)).toBeNull();
    });

    it("returns null when eventId is missing", () => {
      const config: WebhookConfig = {
        eventName: "webhook.received",
        sourceType: "webhook",
      };

      const watcher = new SimpleWebhookWatcher(config);
      const payload = {
        timestamp: 1704067200000,
        data: "test",
      };

      expect(watcher.receive(payload)).toBeNull();
    });

    it("returns null when eventId is empty string", () => {
      const config: WebhookConfig = {
        eventName: "webhook.received",
        sourceType: "webhook",
      };

      const watcher = new SimpleWebhookWatcher(config);
      const payload = {
        id: "",
        timestamp: 1704067200000,
      };

      expect(watcher.receive(payload)).toBeNull();
    });

    it("uses custom field mapping for eventId", () => {
      const config: WebhookConfig = {
        eventName: "webhook.received",
        sourceType: "webhook",
        fieldMapping: {
          eventId: "event_id",
        },
      };

      const watcher = new SimpleWebhookWatcher(config);
      const payload = {
        event_id: "custom-123",
        timestamp: 1704067200000,
      };

      const envelope = watcher.receive(payload);

      expect(envelope).not.toBeNull();
      expect(envelope?.eventId).toBe("custom-123");
    });

    it("uses custom field mapping for timestamp", () => {
      const config: WebhookConfig = {
        eventName: "webhook.received",
        sourceType: "webhook",
        fieldMapping: {
          timestamp: "created_at",
        },
      };

      const watcher = new SimpleWebhookWatcher(config);
      const timestamp = 1704067200000;
      const payload = {
        id: "evt-123",
        created_at: timestamp,
      };

      const envelope = watcher.receive(payload);

      expect(envelope).not.toBeNull();
      expect(envelope?.occurredAt).toBe(new Date(timestamp).toISOString());
    });

    it("handles string timestamp in field mapping", () => {
      const config: WebhookConfig = {
        eventName: "webhook.received",
        sourceType: "webhook",
        fieldMapping: {
          timestamp: "timestamp_str",
        },
      };

      const watcher = new SimpleWebhookWatcher(config);
      const isoString = "2024-01-01T12:00:00Z";
      const payload = {
        id: "evt-123",
        timestamp_str: isoString,
      };

      const envelope = watcher.receive(payload);

      expect(envelope).not.toBeNull();
      expect(envelope?.occurredAt).toBe(isoString);
    });

    it("defaults to current timestamp when timestamp field missing", () => {
      const config: WebhookConfig = {
        eventName: "webhook.received",
        sourceType: "webhook",
      };

      const watcher = new SimpleWebhookWatcher(config);
      const payload = {
        id: "evt-123",
      };

      const before = new Date();
      const envelope = watcher.receive(payload);
      const after = new Date();

      expect(envelope).not.toBeNull();
      const envelopeTime = new Date(envelope!.occurredAt);
      expect(envelopeTime.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(envelopeTime.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("uses custom field mapping for sourceId", () => {
      const config: WebhookConfig = {
        eventName: "webhook.received",
        sourceType: "webhook",
        fieldMapping: {
          sourceId: "source_identifier",
        },
      };

      const watcher = new SimpleWebhookWatcher(config);
      const payload = {
        id: "evt-123",
        source_identifier: "src-456",
      };

      const envelope = watcher.receive(payload);

      expect(envelope).not.toBeNull();
      expect(envelope?.source.id).toBe("src-456");
    });

    it("ignores non-string sourceId", () => {
      const config: WebhookConfig = {
        eventName: "webhook.received",
        sourceType: "webhook",
      };

      const watcher = new SimpleWebhookWatcher(config);
      const payload = {
        id: "evt-123",
        sourceId: 123,
      };

      const envelope = watcher.receive(payload);

      expect(envelope).not.toBeNull();
      expect(envelope?.source.id).toBeUndefined();
    });

    it("preserves entire payload in envelope", () => {
      const config: WebhookConfig = {
        eventName: "webhook.received",
        sourceType: "webhook",
      };

      const watcher = new SimpleWebhookWatcher(config);
      const payload = {
        id: "evt-123",
        timestamp: 1704067200000,
        nested: {
          field: "value",
          array: [1, 2, 3],
        },
        boolean: true,
      };

      const envelope = watcher.receive(payload);

      expect(envelope).not.toBeNull();
      expect(envelope?.payload).toEqual(payload);
    });

    it("validates envelope before returning", () => {
      const config: WebhookConfig = {
        eventName: "webhook.received",
        sourceType: "webhook",
      };

      const watcher = new SimpleWebhookWatcher(config);

      // Create a custom watcher that returns invalid envelope
      class InvalidWebhookWatcher extends WebhookWatcher {
        onPayload(): EventEnvelope | null {
          return {
            eventId: "",
            name: "test",
            source: { type: "test" },
            occurredAt: "2024-01-01T00:00:00Z",
            receivedAt: "2024-01-01T00:00:00Z",
            traceId: "trace-123",
            payload: null,
          };
        }
      }

      const invalidWatcher = new InvalidWebhookWatcher(config);
      const result = invalidWatcher.receive({});

      expect(result).toBeNull();
    });

    it("handles multiple field mappings together", () => {
      const config: WebhookConfig = {
        eventName: "custom.event",
        sourceType: "external_api",
        fieldMapping: {
          eventId: "webhook_id",
          timestamp: "occurred_at",
          sourceId: "api_source",
        },
      };

      const watcher = new SimpleWebhookWatcher(config);
      const payload = {
        webhook_id: "wh-789",
        occurred_at: 1704067200000,
        api_source: "api-001",
        extra: "data",
      };

      const envelope = watcher.receive(payload);

      expect(envelope).not.toBeNull();
      expect(envelope?.eventId).toBe("wh-789");
      expect(envelope?.occurredAt).toBe(new Date(1704067200000).toISOString());
      expect(envelope?.source.id).toBe("api-001");
      expect(envelope?.name).toBe("custom.event");
      expect(envelope?.source.type).toBe("external_api");
    });
  });

  describe("WebhookWatcher abstract class", () => {
    it("enforces abstract onPayload method", () => {
      const config: WebhookConfig = {
        eventName: "test",
        sourceType: "test",
      };

      class TestWatcher extends WebhookWatcher {
        onPayload(): EventEnvelope | null {
          return null;
        }
      }

      const watcher = new TestWatcher(config);
      expect(watcher).toBeDefined();
    });

    it("receive() calls onPayload and validates", () => {
      const config: WebhookConfig = {
        eventName: "test",
        sourceType: "test",
      };

      let onPayloadCalled = false;

      class TestWatcher extends WebhookWatcher {
        onPayload(payload: unknown): EventEnvelope | null {
          onPayloadCalled = true;
          if (typeof payload === "object" && payload !== null) {
            const obj = payload as Record<string, unknown>;
            return {
              eventId: "test-123",
              name: "test",
              source: { type: "test" },
              occurredAt: "2024-01-01T00:00:00Z",
              receivedAt: "2024-01-01T00:00:00Z",
              traceId: "trace-123",
              payload: obj,
            };
          }
          return null;
        }
      }

      const watcher = new TestWatcher(config);
      const result = watcher.receive({ data: "test" });

      expect(onPayloadCalled).toBe(true);
      expect(result).not.toBeNull();
    });

    it("receive() returns null if onPayload returns null", () => {
      const config: WebhookConfig = {
        eventName: "test",
        sourceType: "test",
      };

      class TestWatcher extends WebhookWatcher {
        onPayload(): EventEnvelope | null {
          return null;
        }
      }

      const watcher = new TestWatcher(config);
      const result = watcher.receive({ data: "test" });

      expect(result).toBeNull();
    });
  });
});
