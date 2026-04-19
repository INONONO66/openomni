import { afterEach, describe, expect, it } from "bun:test";
import { Telemetry } from "@openomni/session";

afterEach(() => {
  Telemetry.reset();
});

describe("Telemetry", () => {
  describe("when disabled", () => {
    it("isEnabled returns false by default", () => {
      expect(Telemetry.isEnabled()).toBe(false);
    });

    it("span executes the function and returns its result", async () => {
      Telemetry.init({ enabled: false });
      const result = await Telemetry.span("test.span", async () => 42);
      expect(result).toBe(42);
    });

    it("span propagates errors from the function", async () => {
      Telemetry.init({ enabled: false });
      await expect(
        Telemetry.span("test.span", async () => {
          throw new Error("test error");
        }),
      ).rejects.toThrow("test error");
    });

    it("counter.add is a no-op", () => {
      Telemetry.init({ enabled: false });
      const counter = Telemetry.counter("test.counter");
      expect(() => counter.add(1)).not.toThrow();
    });

    it("histogram.record is a no-op", () => {
      Telemetry.init({ enabled: false });
      const histogram = Telemetry.histogram("test.histogram");
      expect(() => histogram.record(100)).not.toThrow();
    });
  });

  describe("when enabled", () => {
    it("isEnabled returns true after init with enabled: true", () => {
      Telemetry.init({ enabled: true });
      expect(Telemetry.isEnabled()).toBe(true);
    });

    it("span executes the function and returns its result", async () => {
      Telemetry.init({ enabled: true });
      const result = await Telemetry.span("test.span", async () => "hello");
      expect(result).toBe("hello");
    });

    it("span propagates errors from the function", async () => {
      Telemetry.init({ enabled: true });
      await expect(
        Telemetry.span("test.span", async () => {
          throw new Error("otel error");
        }),
      ).rejects.toThrow("otel error");
    });

    it("counter.add does not throw", () => {
      Telemetry.init({ enabled: true });
      const counter = Telemetry.counter("test.counter");
      expect(() => counter.add(1, { label: "value" })).not.toThrow();
    });

    it("histogram.record does not throw", () => {
      Telemetry.init({ enabled: true });
      const histogram = Telemetry.histogram("test.histogram");
      expect(() => histogram.record(50, { label: "value" })).not.toThrow();
    });
  });

  describe("reset", () => {
    it("disables telemetry after reset", () => {
      Telemetry.init({ enabled: true });
      expect(Telemetry.isEnabled()).toBe(true);
      Telemetry.reset();
      expect(Telemetry.isEnabled()).toBe(false);
    });
  });
});
