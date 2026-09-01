import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BusEvent } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { z } from "zod";
import { signalAfterDeliveries, withinTimeout } from "./delivery-signal";

const TestEventSchema = z.object({
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  label: z.string().optional(),
});
type TestEvent = z.infer<typeof TestEventSchema>;

const cases: ReadonlyArray<{
  name: string;
  match?: Partial<TestEvent>;
  events: TestEvent[];
  expected: string[];
}> = [
  {
    name: "backward compat: no options receives all events",
    events: [{ sessionId: "a", label: "x" }, { sessionId: "b", label: "y" }],
    expected: ["x", "y"],
  },
  {
    name: "matches single sessionId key",
    match: { sessionId: "a" },
    events: [{ sessionId: "a", label: "x" }, { sessionId: "b", label: "y" }, { sessionId: "a", label: "z" }],
    expected: ["x", "z"],
  },
  {
    name: "requires all match keys (AND semantics)",
    match: { sessionId: "a", runId: "r1" },
    events: [
      { sessionId: "a", runId: "r1", label: "match" },
      { sessionId: "a", runId: "r2", label: "skip-runId" },
      { sessionId: "b", runId: "r1", label: "skip-session" },
      { sessionId: "a", label: "skip-no-runId" },
    ],
    expected: ["match"],
  },
  {
    name: "absent key never matches",
    match: { sessionId: "x" },
    events: [{ runId: "r", label: "no-sessionId" }, { label: "empty" }],
    expected: [],
  },
  {
    name: "empty match object fires all events",
    match: {},
    events: [{ sessionId: "a", label: "p" }, { label: "q" }],
    expected: ["p", "q"],
  },
];

describe("Bus.subscribe match filter", () => {
  beforeEach(Bus.reset);
  afterEach(Bus.reset);

  for (const { name, match, events, expected } of cases) {
    it(name, async () => {
      const event = BusEvent.define<TestEvent>(`test:${name}`, TestEventSchema);
      const seen: string[] = [];
      const handler = (data: TestEvent) => seen.push(data.label ?? "");
      if (match === undefined) Bus.subscribe(event, handler);
      else Bus.subscribe(event, handler, { match });
      const delivered = signalAfterDeliveries(event, events.length);
      for (const data of events) Bus.publish(event, data);
      await delivered;
      expect(seen).toEqual(expected);
    });
  }

  it("multiple subscribers with different match fire independently", async () => {
    const event = BusEvent.define<TestEvent>("test:multi", TestEventSchema);
    const seenA: string[] = [];
    const seenB: string[] = [];
    Bus.subscribe(event, ({ label }) => seenA.push(label ?? ""), { match: { sessionId: "A" } });
    Bus.subscribe(event, ({ label }) => seenB.push(label ?? ""), { match: { sessionId: "B" } });
    const events = [
      { sessionId: "A", label: "alpha" },
      { sessionId: "B", label: "bravo" },
      { sessionId: "C", label: "charlie" },
    ];
    const delivered = signalAfterDeliveries(event, events.length);
    for (const data of events) Bus.publish(event, data);
    await delivered;
    expect(seenA).toEqual(["alpha"]);
    expect(seenB).toEqual(["bravo"]);
  });

  it("unsubscribe still works under match filter", async () => {
    const event = BusEvent.define<TestEvent>("test:unsub", TestEventSchema);
    const seen: string[] = [];
    const unsub = Bus.subscribe(event, ({ label }) => seen.push(label ?? ""), { match: { sessionId: "x" } });
    const firstDelivered = signalAfterDeliveries(event, 1);
    Bus.publish(event, { sessionId: "x", label: "first" });
    await firstDelivered;
    expect(seen).toEqual(["first"]);

    unsub();
    const secondDelivered = signalAfterDeliveries(event, 1);
    Bus.publish(event, { sessionId: "x", label: "second" });
    await secondDelivered;
    expect(seen).toEqual(["first"]);
  });

  it("accepts scoped metadata around a strict event payload", async () => {
    const event = BusEvent.define("test:strict-metadata", z.object({ label: z.string() }).strict());
    const delivered = Promise.withResolvers<void>();
    const enriched = { label: "kept", traceId: "trace-strict" };
    let received: { label: string } | undefined;
    Bus.subscribe(event, (data) => {
      received = data;
      delivered.resolve();
    });

    Bus.publish(event, enriched);
    await withinTimeout(delivered.promise);

    expect(received).toBe(enriched);
  });


  it("type safety: invalid keys in match are rejected at compile time", () => {
    const event = BusEvent.define<TestEvent>("test:type", TestEventSchema);
    Bus.subscribe(event, () => undefined, {
      // @ts-expect-error - 'invalidKey' is not a key of TestEvent
      match: { invalidKey: "z" },
    });
  });
});
