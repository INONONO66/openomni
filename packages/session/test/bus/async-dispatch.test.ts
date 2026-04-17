import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Bus, BusEvent } from "../../src/bus/index.js";
import { Log } from "../../src/log/index.js";

describe("Bus async dispatch", () => {
  beforeEach(() => {
    Bus.reset();
  });

  afterEach(() => {
    Bus.reset();
  });

  it("publish() returns immediately (non-blocking)", async () => {
    const event = BusEvent.define("test:event", (s) => s);
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
    const event = BusEvent.define("test:error", (s) => s);
    const results: string[] = [];
    let logWarnCalled = false;

    const originalWarn = Log.warn;
    Log.warn = (msg: string, ctx?: Record<string, unknown>) => {
      logWarnCalled = true;
      expect(msg).toBe("Bus handler error");
      expect(ctx?.event).toBe("test:error");
    };

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
    expect(logWarnCalled).toBe(true);

    Log.warn = originalWarn;
  });

  it("FIFO order is preserved across multiple publishes", async () => {
    const event = BusEvent.define("test:order", (s) => s);
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
    const event = BusEvent.define("test:snapshot", (s) => s);
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
});
