import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { BusEvent } from "@openomni/protocol";
import { Bus } from "../../src/index";
import { withinTimeout } from "./delivery-signal";

const TestEvent = BusEvent.define(
  "test.observe.delivery",
  z.object({ traceId: z.string(), n: z.number() }),
);

describe("Bus.observe delivery (#606 audit M1)", () => {
  afterEach(() => {
    Bus.reset();
  });

  test("observers receive every publish — the journal rides this path", async () => {
    // The durable WAL journal is a wildcard observer: losing this delivery
    // silently kills persistence while every subscriber-based test stays
    // green (the audit's surviving mutant).
    const seen: Array<{ name: string; n: number }> = [];
    let delivered!: () => void;
    const bothDelivered = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const unsubscribe = Bus.observe((descriptor, data) => {
      seen.push({ name: descriptor.name, n: (data as { n: number }).n });
      if (seen.length === 2) delivered();
    });

    Bus.publish(TestEvent, { traceId: "trace-observe", n: 1 });
    Bus.publish(TestEvent, { traceId: "trace-observe", n: 2 });
    await bothDelivered;

    expect(seen).toEqual([
      { name: "test.observe.delivery", n: 1 },
      { name: "test.observe.delivery", n: 2 },
    ]);

    unsubscribe();
    const dispatchCompleted = Promise.withResolvers<void>();
    const unsubscribeSentinel = Bus.observe(() => {
      dispatchCompleted.resolve();
    });
    Bus.publish(TestEvent, { traceId: "trace-observe", n: 3 });
    await withinTimeout(dispatchCompleted.promise);
    unsubscribeSentinel();
    expect(seen).toHaveLength(2);
  });

  test("observer descriptors retain their runtime parser", async () => {
    const event = BusEvent.define("test.observe.schema", z.string());
    const delivered = Promise.withResolvers<void>();
    const results: boolean[] = [];
    Bus.observe((descriptor, data) => {
      results.push(descriptor.schema.safeParse(data).success);
      results.push(descriptor.schema.safeParse(42).success);
      delivered.resolve();
    });

    Bus.publish(event, "valid");
    await withinTimeout(delivered.promise);

    expect(results).toEqual([true, false]);
  });

  test("observers preserve every JavaScript primitive", async () => {
    const event = BusEvent.define("test.observe.primitives", z.unknown());
    const delivered = Promise.withResolvers<void>();
    const seen: Bus.Data[] = [];
    Bus.observe((_descriptor, data) => {
      seen.push(data);
      if (seen.length === 5) delivered.resolve();
    });

    const symbol = Symbol.for("bus-test");
    Bus.publish(event, 1n);
    Bus.publish(event, true);
    Bus.publish(event, 1);
    Bus.publish(event, symbol);
    Bus.publish(event, undefined);
    await withinTimeout(delivered.promise);

    expect(seen).toEqual([1n, true, 1, symbol, undefined]);
  });

  test("a throwing observer never breaks delivery to the others", async () => {
    const survived: number[] = [];
    let delivered!: () => void;
    const survivorDelivered = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    Bus.observe(() => {
      throw new Error("hostile observer");
    });
    Bus.observe((_descriptor, data) => {
      survived.push((data as { n: number }).n);
      delivered();
    });

    Bus.publish(TestEvent, { traceId: "trace-observe", n: 7 });
    await survivorDelivered;

    expect(survived).toEqual([7]);
  });
});
