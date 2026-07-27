import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { z } from "zod";
import { Bus, BusEvent } from "../../src/bus/index.js";

const flush = async () => {
  await new Promise((resolve) => queueMicrotask(resolve));
};

describe("Bus dispatch failures", () => {
  beforeEach(() => {
    Bus.reset();
  });

  afterEach(() => {
    Bus.reset();
  });

  it("reports observer failures without isolating subscribers or publish", async () => {
    const event = BusEvent.define("test:observer-failure", z.string());
    const failures: Bus.ErrorFact[] = [];
    const deliveries: string[] = [];

    Bus.setErrorSink((failure) => failures.push(failure));
    Bus.observe(() => {
      throw new Error("observer failed");
    });
    Bus.subscribe(event, (value) => deliveries.push(value));

    Bus.publish(event, "first");
    expect(failures).toEqual([]);
    expect(deliveries).toEqual([]);
    expect(Bus.failureStats()).toEqual({
      observerFailureCount: 0,
      subscriberFailureCount: 0,
    });

    await flush();

    expect(failures).toEqual([
      {
        eventName: "test:observer-failure",
        phase: "observer",
        error: "Error: observer failed",
      },
    ]);
    expect(deliveries).toEqual(["first"]);

    Bus.publish(event, "second");
    await flush();

    expect(deliveries).toEqual(["first", "second"]);
    expect(Bus.failureStats()).toEqual({
      observerFailureCount: 2,
      subscriberFailureCount: 0,
    });
  });

  it("reports subscriber failures without isolating observers or other subscribers", async () => {
    const event = BusEvent.define("test:subscriber-failure", z.string());
    const failures: Bus.ErrorFact[] = [];
    const observations: string[] = [];
    const deliveries: string[] = [];

    const originalError = console.error;
    const errorLog = mock(() => undefined);
    console.error = errorLog;
    Bus.setErrorSink((failure) => {
      failures.push(failure);
      throw new Error("sink failed");
    });
    Bus.observe((_descriptor, value) => observations.push(String(value)));
    Bus.subscribe(event, () => {
      throw new Error("subscriber failed");
    });
    Bus.subscribe(event, (value) => deliveries.push(value));

    try {
      expect(() => Bus.publish(event, "payload")).not.toThrow();
      await flush();
    } finally {
      console.error = originalError;
    }

    expect(failures).toEqual([
      {
        eventName: "test:subscriber-failure",
        phase: "subscriber",
        error: "Error: subscriber failed",
      },
    ]);
    expect(errorLog).toHaveBeenCalledWith("Bus error sink failure", {
      eventName: "test:subscriber-failure",
      phase: "subscriber",
      error: "Error: subscriber failed",
      sinkError: "Error: sink failed",
    });
    expect(observations).toEqual(["payload"]);
    expect(deliveries).toEqual(["payload"]);
    expect(Bus.failureStats()).toEqual({
      observerFailureCount: 0,
      subscriberFailureCount: 1,
    });
  });

  it("reset clears the error sink and failure counters", async () => {
    const event = BusEvent.define("test:failure-reset", z.string());
    const failures: Bus.ErrorFact[] = [];

    Bus.setErrorSink((failure) => failures.push(failure));
    Bus.subscribe(event, () => {
      throw new Error("before reset");
    });
    Bus.publish(event, "payload");
    await flush();

    expect(failures).toHaveLength(1);
    Bus.reset();
    expect(Bus.failureStats()).toEqual({
      observerFailureCount: 0,
      subscriberFailureCount: 0,
    });

    const originalWarn = console.warn;
    const warn = mock(() => undefined);
    console.warn = warn;
    Bus.subscribe(event, () => {
      throw new Error("after reset");
    });
    Bus.publish(event, "after reset");
    await flush();
    console.warn = originalWarn;

    expect(failures).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("Bus dispatch error", {
      eventName: "test:failure-reset",
      phase: "subscriber",
      error: "Error: after reset",
    });
  });
});
