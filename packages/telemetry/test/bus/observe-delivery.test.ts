import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { Bus, BusEvent } from "../../src/index";

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
    const unsubscribe = Bus.observe((descriptor, data) => {
      seen.push({ name: descriptor.name, n: (data as { n: number }).n });
    });

    Bus.publish(TestEvent, { traceId: "trace-observe", n: 1 });
    Bus.publish(TestEvent, { traceId: "trace-observe", n: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual([
      { name: "test.observe.delivery", n: 1 },
      { name: "test.observe.delivery", n: 2 },
    ]);

    unsubscribe();
    Bus.publish(TestEvent, { traceId: "trace-observe", n: 3 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toHaveLength(2);
  });

  test("a throwing observer never breaks delivery to the others", async () => {
    const survived: number[] = [];
    Bus.observe(() => {
      throw new Error("hostile observer");
    });
    Bus.observe((_descriptor, data) => {
      survived.push((data as { n: number }).n);
    });

    Bus.publish(TestEvent, { traceId: "trace-observe", n: 7 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(survived).toEqual([7]);
  });
});
