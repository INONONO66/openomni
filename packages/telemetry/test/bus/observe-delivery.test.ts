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
