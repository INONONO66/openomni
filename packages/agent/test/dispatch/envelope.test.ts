import { describe, it, expect } from "bun:test";
import {
  normalize,
  Envelope,
  ValidationError,
  EventEnvelope,
} from "../../src/dispatch/envelope";

describe("Envelope Functions", () => {
  describe("normalize", () => {
    it("throws ValidationError for missing eventId", () => {
      const input = {
        name: "test-event",
        source: { type: "test-source" },
      };

      expect(() => normalize(input)).toThrow(ValidationError);
      expect(() => normalize(input)).toThrow("Missing required field: eventId");
    });

    it("throws ValidationError for missing name", () => {
      const input = {
        eventId: "test-id",
        source: { type: "test-source" },
      };

      expect(() => normalize(input)).toThrow(ValidationError);
      expect(() => normalize(input)).toThrow("Missing required field: name");
    });

    it("throws ValidationError for missing source", () => {
      const input = {
        eventId: "test-id",
        name: "test-event",
      };

      expect(() => normalize(input)).toThrow(ValidationError);
      expect(() => normalize(input)).toThrow("Missing required field: source");
    });

    it("generates traceId when not provided", () => {
      const input = {
        eventId: "test-id",
        name: "test-event",
        source: { type: "test-source" },
      };

      const result = normalize(input);

      expect(result.traceId).toBeDefined();
      expect(typeof result.traceId).toBe("string");
      expect(result.traceId.length).toBeGreaterThan(0);
    });

    it("converts numeric timestamp to occurredAt ISO string", () => {
      const testTime = 1609459200000;
      const input = {
        eventId: "test-id",
        name: "test-event",
        source: { type: "test-source" },
        timestamp: testTime,
      };

      const result = normalize(input);

      expect(result.occurredAt).toBe("2021-01-01T00:00:00.000Z");
      expect(typeof result.occurredAt).toBe("string");
      expect(typeof result.receivedAt).toBe("string");
    });
  });

  describe("Envelope.create", () => {
    it("returns new envelope with generated eventId and traceId", () => {
      const result = Envelope.create("test-event", "test-source", {
        data: "test",
      });

      expect(result.eventId).toBeDefined();
      expect(typeof result.eventId).toBe("string");
      expect(result.eventId.length).toBeGreaterThan(0);

      expect(result.traceId).toBeDefined();
      expect(typeof result.traceId).toBe("string");
      expect(result.traceId.length).toBeGreaterThan(0);

      expect(result.name).toBe("test-event");
      expect(result.source.type).toBe("test-source");
      expect(result.payload).toEqual({ data: "test" });
      expect(result.occurredAt).toBeDefined();
      expect(result.receivedAt).toBeDefined();
    });
  });

  describe("Envelope.validate", () => {
    it("returns true for valid envelope", () => {
      const validEnvelope: EventEnvelope = {
        eventId: "test-id",
        name: "test-event",
        source: { type: "test-source" },
        payload: { data: "test" },
        occurredAt: "2021-01-01T00:00:00.000Z",
        receivedAt: "2021-01-01T00:00:01.000Z",
        traceId: "test-trace-id",
      };

      const result = Envelope.validate(validEnvelope);

      expect(result).toBe(true);
    });
  });

  describe("Envelope.isExpired", () => {
    it("returns true for old envelopes", () => {
      const twoHoursAgo = new Date(
        Date.now() - 2 * 60 * 60 * 1000,
      ).toISOString();
      const oldEnvelope: EventEnvelope = {
        eventId: "test-id",
        name: "test-event",
        source: { type: "test-source" },
        payload: null,
        occurredAt: twoHoursAgo,
        receivedAt: twoHoursAgo,
        traceId: "test-trace-id",
      };

      const result = Envelope.isExpired(oldEnvelope, 60 * 60 * 1000);

      expect(result).toBe(true);
    });
  });
});
