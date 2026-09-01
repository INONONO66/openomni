import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { z } from "zod";
import { BusEvent } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { withinTimeout } from "./delivery-signal";

describe("Bus async dispatch", () => {
  beforeEach(() => {
    Bus.reset();
  });

  afterEach(() => {
    Bus.reset();
  });

  it("publish() returns immediately (non-blocking)", async () => {
    const event = BusEvent.define("test:event", z.string());
    let handlerCalled = false;
    const delivered = Promise.withResolvers<void>();

    Bus.subscribe(event, () => {
      handlerCalled = true;
      delivered.resolve();
    });

    Bus.publish(event, "data");

    expect(handlerCalled).toBe(false);
    await withinTimeout(delivered.promise);
    expect(handlerCalled).toBe(true);
  });

  it("handler errors are logged and other handlers continue", async () => {
    const event = BusEvent.define("test:error", z.string());
    const results: string[] = [];
    const delivered = Promise.withResolvers<void>();

    const originalWarn = console.warn;
    const warnSpy = mock(() => undefined);
    console.warn = warnSpy;

    try {
      Bus.subscribe(event, () => {
        results.push("handler1");
        throw new Error("handler1 error");
      });

      Bus.subscribe(event, () => {
        results.push("handler2");
        delivered.resolve();
      });

      Bus.publish(event, "data");
      await withinTimeout(delivered.promise);

      expect(results).toEqual(["handler1", "handler2"]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });

  it("FIFO order is preserved across multiple publishes", async () => {
    const event = BusEvent.define("test:order", z.string());
    const order: string[] = [];
    const delivered = Promise.withResolvers<void>();

    Bus.subscribe(event, () => {
      order.push("handler1");
    });

    Bus.subscribe(event, () => {
      order.push("handler2");
      if (order.length === 4) delivered.resolve();
    });

    Bus.publish(event, "data1");
    Bus.publish(event, "data2");

    await withinTimeout(delivered.promise);
    expect(order).toEqual(["handler1", "handler2", "handler1", "handler2"]);
  });

  it("handler snapshot prevents mutation during dispatch", async () => {
    const event = BusEvent.define("test:snapshot", z.string());
    const results: string[] = [];
    const delivered = Promise.withResolvers<void>();

    const unsubscribe = Bus.subscribe(event, () => {
      results.push("handler1");
      unsubscribe();
    });

    Bus.subscribe(event, () => {
      results.push("handler2");
      delivered.resolve();
    });

    Bus.publish(event, "data");

    await withinTimeout(delivered.promise);
    expect(results).toEqual(["handler1", "handler2"]);
  });

  it("isolates scoped subscriptions from root state", async () => {
    const event = BusEvent.define("test:isolation", z.string());
    const delivered = Promise.withResolvers<void>();

    await Bus.withIsolation(async () => {
      Bus.subscribe(event, () => delivered.resolve());
      expect(Bus.stats().subscriberCount).toBe(1);
      Bus.publish(event, "scoped");
      await withinTimeout(delivered.promise);
    });

    expect(Bus.stats().subscriberCount).toBe(0);
  });

  it("removes empty subscriber sets after the last unsubscribe", async () => {
    const event = BusEvent.define("test:cleanup", z.string());
    const unsubscribe = Bus.subscribe(event, () => undefined);
    expect(Bus.stats().subscriberEventCount).toBe(1);

    unsubscribe();
    expect(Bus.stats()).toEqual({
      subscriberEventCount: 0,
      subscriberCount: 0,
      observerCount: 0,
    });

    const delivered = Promise.withResolvers<void>();
    Bus.subscribe(event, () => {
      delivered.resolve();
    });
    Bus.publish(event, "data");
    await withinTimeout(delivered.promise);
  });
});
