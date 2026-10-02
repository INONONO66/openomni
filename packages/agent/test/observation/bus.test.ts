import { afterEach, describe, expect, it } from "bun:test";
import { createObservationBus, ObservationDeliveryFailed } from "../../src/session/bus";
import { BusEvent } from "@openomni/protocol";
import { z } from "zod";

import { bounded } from "../helpers/bounded";

/** Deterministic injected sources: counter ids, counter times. */
function sourceOptions() {
  let id = 0;
  let time = 0;
  return { id: () => `bus-event-${++id}`, now: () => ++time };
}

const buses: ReturnType<typeof createObservationBus>[] = [];
function bus() {
  const created = createObservationBus(sourceOptions());
  buses.push(created);
  return created;
}

afterEach(() => {
  for (const created of buses.splice(0)) created.reset();
});

describe("observation bus delivery", () => {
  it("publishes asynchronously in FIFO subscriber order", async () => {
    const observations = bus();
    const event = BusEvent.define("test.bus.fifo", z.string());
    const seen: string[] = [];
    const delivered = Promise.withResolvers<void>();
    observations.subscribe(event, (value) => seen.push(`first:${value}`));
    observations.subscribe(event, (value) => {
      seen.push(`second:${value}`);
      if (seen.length === 4) delivered.resolve();
    });

    observations.publish(event, "one");
    observations.publish(event, "two");
    expect(seen).toEqual([]);
    await bounded(delivered.promise);

    expect(seen).toEqual(["first:one", "second:one", "first:two", "second:two"]);
  });

  it("isolates a throwing subscriber while preserving the publish snapshot", async () => {
    const observations = bus();
    const event = BusEvent.define("test.bus.errors", z.string());
    const seen: string[] = [];
    const delivered = Promise.withResolvers<void>();
    const reported = Promise.withResolvers<{ eventName: string; error: string }>();
    const unsubscribe = observations.subscribe(event, () => {
      unsubscribe();
      throw new Error("subscriber failed");
    });
    observations.subscribe(event, (value) => {
      seen.push(value);
      delivered.resolve();
    });
    observations.subscribe(ObservationDeliveryFailed, (failure) => reported.resolve(failure));

    observations.publish(event, "survived");
    await bounded(delivered.promise);
    expect(seen).toEqual(["survived"]);
    // Without an injected reporter the failure is a fact on the bus itself, not a log line.
    expect(await bounded(reported.promise)).toEqual({
      eventName: event.name,
      error: "Error: subscriber failed",
    });
  });

  it("never reports a failing delivery of the failure report itself", async () => {
    const observations = bus();
    const event = BusEvent.define("test.bus.failure-loop", z.string());
    const observed: string[] = [];
    const settled = Promise.withResolvers<void>();
    observations.observe((published) => {
      observed.push(published.name);
      if (published.name === ObservationDeliveryFailed.name) {
        queueMicrotask(() => queueMicrotask(() => settled.resolve()));
      }
      throw new Error("observer always fails");
    });

    observations.publish(event, "once");
    await bounded(settled.promise);
    expect(observed).toEqual([event.name, ObservationDeliveryFailed.name]);
  });

  it("delivers the original handler failure to the injected error sink", async () => {
    const failure = new Error("subscriber failure");
    const reported = Promise.withResolvers<{ error: Error; event: string }>();
    const observations = createObservationBus({
      ...sourceOptions(),
      onError: (error, event) => reported.resolve({ error, event }),
    });
    const event = BusEvent.define("test.bus.error-sink", z.string());
    observations.subscribe(event, () => {
      throw failure;
    });
    observations.publish(event, "payload");
    expect(await bounded(reported.promise)).toEqual({ error: failure, event: event.name });
  });

  it("filters subscriptions by all requested payload fields", async () => {
    const observations = bus();
    const event = BusEvent.define(
      "test.bus.match",
      z.object({ sessionId: z.string().optional(), runId: z.string().optional() }),
    );
    const seen: string[] = [];
    observations.subscribe(event, (value) => seen.push(value.runId ?? "missing"), {
      match: { sessionId: "session-1", runId: "run-1" },
    });
    const delivered = Promise.withResolvers<void>();
    const stop = observations.observe((_event, data) => {
      if (typeof data === "object" && data !== null && Reflect.get(data, "runId") === "run-3") {
        delivered.resolve();
      }
    });

    observations.publish(event, { sessionId: "session-1", runId: "run-1" });
    observations.publish(event, { sessionId: "session-1", runId: "run-2" });
    observations.publish(event, { runId: "run-3" });
    await bounded(delivered.promise);
    stop();

    expect(seen).toEqual(["run-1"]);
  });

  it("delivers runtime descriptors and every primitive to observers", async () => {
    const observations = bus();
    const event = BusEvent.define(
      "test.bus.primitives",
      z.union([
        z.bigint(),
        z.boolean(),
        z.number(),
        z.string(),
        z.symbol(),
        z.undefined(),
        z.null(),
      ]),
    );
    const values: Array<bigint | boolean | null | number | string | symbol | undefined> = [];
    const parses: boolean[] = [];
    const delivered = Promise.withResolvers<void>();
    observations.observe((descriptor, data) => {
      if (typeof data === "object" && data !== null) throw new Error("unexpected object payload");
      values.push(data);
      parses.push(descriptor.schema.safeParse(data).success);
      if (values.length === 7) delivered.resolve();
    });
    const symbol = Symbol.for("bus-test");

    for (const value of [1n, true, 1, "value", symbol, undefined, null] as const) {
      observations.publish(event, value);
    }
    await bounded(delivered.promise);

    expect(values).toEqual([1n, true, 1, "value", symbol, undefined, null]);
    expect(parses).toEqual([true, true, true, true, true, true, true]);
  });

  it("keeps isolated subscriptions out of root delivery", async () => {
    const observations = bus();
    const event = BusEvent.define("test.bus.isolation", z.string());
    const isolated = Promise.withResolvers<void>();
    await observations.withIsolation(async () => {
      observations.subscribe(event, () => isolated.resolve());
      observations.publish(event, "inside");
      await bounded(isolated.promise);
    });
    let rootCalls = 0;
    const rootDelivered = Promise.withResolvers<void>();
    observations.observe(() => rootDelivered.resolve());
    observations.subscribe(event, () => {
      rootCalls += 1;
    });

    observations.publish(event, "outside");
    await bounded(rootDelivered.promise);

    expect(rootCalls).toBe(1);
  });
});
