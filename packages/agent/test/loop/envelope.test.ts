import { describe, it, expect } from "bun:test";
import {
  normalize,
  Envelope,
  ValidationError,
  EventEnvelope,
} from "../../src/loop/envelope";

describe("Envelope Functions", () => {
  describe("normalize", () => {
    it("throws ValidationError for missing id", () => {
      const input = {
        name: "test-event",
        source: "test-source",
      };

      expect(() => normalize(input)).toThrow(ValidationError);
      expect(() => normalize(input)).toThrow("Missing required field: id");
    });

    it("throws ValidationError for missing name", () => {
      const input = {
        id: "test-id",
        source: "test-source",
      };

      expect(() => normalize(input)).toThrow(ValidationError);
      expect(() => normalize(input)).toThrow("Missing required field: name");
    });

    it("throws ValidationError for missing source", () => {
      const input = {
        id: "test-id",
        name: "test-event",
      };

      expect(() => normalize(input)).toThrow(ValidationError);
      expect(() => normalize(input)).toThrow("Missing required field: source");
    });

    it("generates traceId when not provided", () => {
      const input = {
        id: "test-id",
        name: "test-event",
        source: "test-source",
      };

      const result = normalize(input);

      expect(result.traceId).toBeDefined();
      expect(typeof result.traceId).toBe("string");
      expect(result.traceId.length).toBeGreaterThan(0);
    });

    it("converts numeric timestamp to ISO string", () => {
      const testTime = 1609459200000;
      const input = {
        id: "test-id",
        name: "test-event",
        source: "test-source",
        timestamp: testTime,
      } as any;

      const result = normalize(input);

      expect(result.timestamp).toBe("2021-01-01T00:00:00.000Z");
      expect(typeof result.timestamp).toBe("string");
    });
  });

  describe("Envelope.create", () => {
    it("returns new envelope with generated id and traceId", () => {
      const result = Envelope.create("test-event", "test-source", {
        data: "test",
      });

      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThan(0);

      expect(result.traceId).toBeDefined();
      expect(typeof result.traceId).toBe("string");
      expect(result.traceId.length).toBeGreaterThan(0);

      expect(result.name).toBe("test-event");
      expect(result.source).toBe("test-source");
      expect(result.payload).toEqual({ data: "test" });
      expect(result.timestamp).toBeDefined();
      expect(typeof result.timestamp).toBe("string");
    });
  });

  describe("Envelope.validate", () => {
    it("returns true for valid envelope", () => {
      const validEnvelope: EventEnvelope = {
        id: "test-id",
        name: "test-event",
        source: "test-source",
        payload: { data: "test" },
        timestamp: "2021-01-01T00:00:00.000Z",
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
        id: "test-id",
        name: "test-event",
        source: "test-source",
        payload: null,
        timestamp: twoHoursAgo,
        traceId: "test-trace-id",
      };

      const result = Envelope.isExpired(oldEnvelope, 60 * 60 * 1000);

      expect(result).toBe(true);
    });
  });
});
