import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { z } from "zod";
import { Bus, BusEvent } from "@openomni/telemetry";

describe("Bus async dispatch", () => {
  beforeEach(() => {
    Bus.reset();
  });

  afterEach(() => {
    Bus.reset();
  });

  it("publish() returns immediately (non-blocking)", async () => {
    const event = BusEvent.define("test:event", z.unknown());
    let handlerCalled = false;

    Bus.subscribe(event, () => {
      handlerCalled = true;
    });

    Bus.publish(event, "data");

    expect(handlerCalled).toBe(false);

    await new Promise((resolve) => queueMicrotask(resolve));

    expect(handlerCalled).toBe(true);
  });

  it("handler errors are logged and other handlers continue", async () => {
    const event = BusEvent.define("test:error", z.unknown());
    const results: string[] = [];

    const originalWarn = console.warn;
    const warnSpy = mock(() => undefined);
    console.warn = warnSpy;

    Bus.subscribe(event, () => {
      results.push("handler1");
      throw new Error("handler1 error");
    });

    Bus.subscribe(event, () => {
      results.push("handler2");
    });

    Bus.publish(event, "data");

    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(results).toEqual(["handler1", "handler2"]);
    expect(warnSpy).toHaveBeenCalled();

    console.warn = originalWarn;
  });

  it("FIFO order is preserved across multiple publishes", async () => {
    const event = BusEvent.define("test:order", z.unknown());
    const order: string[] = [];

    Bus.subscribe(event, () => {
      order.push("handler1");
    });

    Bus.subscribe(event, () => {
      order.push("handler2");
    });

    Bus.publish(event, "data1");
    Bus.publish(event, "data2");

    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(order).toEqual(["handler1", "handler2", "handler1", "handler2"]);
  });

  it("handler snapshot prevents mutation during dispatch", async () => {
    const event = BusEvent.define("test:snapshot", z.unknown());
    const results: string[] = [];

    const unsubscribe = Bus.subscribe(event, () => {
      results.push("handler1");
      unsubscribe();
    });

    Bus.subscribe(event, () => {
      results.push("handler2");
    });

    Bus.publish(event, "data");

    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(results).toEqual(["handler1", "handler2"]);
  });

  it("removes empty subscriber sets after the last unsubscribe", async () => {
    const event = BusEvent.define("test:cleanup", z.unknown());
    const unsubscribe = Bus.subscribe(event, () => undefined);
    expect(Bus.stats().subscriberEventCount).toBe(1);

    unsubscribe();
    expect(Bus.stats()).toEqual({
      subscriberEventCount: 0,
      subscriberCount: 0,
      observerCount: 0,
    });

    let called = false;
    Bus.subscribe(event, () => {
      called = true;
    });
    Bus.publish(event, "data");
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(called).toBe(true);
  });
});
