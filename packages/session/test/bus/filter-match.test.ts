import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { Bus, BusEvent } from "../../src/bus/index.js";

describe("Bus.subscribe match filter", () => {
  beforeEach(() => {
    Bus.reset();
  });

  afterEach(() => {
    Bus.reset();
  });

  const flush = async () => {
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));
  };

  const TestEventSchema = z.object({
    sessionId: z.string().optional(),
    runId: z.string().optional(),
    taskId: z.string().optional(),
    label: z.string().optional(),
  });
  type TestEvent = z.infer<typeof TestEventSchema>;

  it("backward compat: no options receives all events", async () => {
    const event = BusEvent.define<TestEvent>("test:nofilter", TestEventSchema);
    const seen: string[] = [];
    Bus.subscribe(event, (data) => {
      seen.push(data.label ?? "");
    });

    Bus.publish(event, { sessionId: "a", label: "x" });
    Bus.publish(event, { sessionId: "b", label: "y" });
    await flush();

    expect(seen).toEqual(["x", "y"]);
  });

  it("matches single sessionId key", async () => {
    const event = BusEvent.define<TestEvent>("test:single", TestEventSchema);
    const seen: string[] = [];
    Bus.subscribe(
      event,
      (data) => {
        seen.push(data.label ?? "");
      },
      { match: { sessionId: "a" } },
    );

    Bus.publish(event, { sessionId: "a", label: "x" });
    Bus.publish(event, { sessionId: "b", label: "y" });
    Bus.publish(event, { sessionId: "a", label: "z" });
    await flush();

    expect(seen).toEqual(["x", "z"]);
  });

  it("requires all match keys (AND semantics)", async () => {
    const event = BusEvent.define<TestEvent>("test:and", TestEventSchema);
    const seen: string[] = [];
    Bus.subscribe(
      event,
      (data) => {
        seen.push(data.label ?? "");
      },
      { match: { sessionId: "a", runId: "r1" } },
    );

    Bus.publish(event, { sessionId: "a", runId: "r1", label: "match" });
    Bus.publish(event, { sessionId: "a", runId: "r2", label: "skip-runId" });
    Bus.publish(event, { sessionId: "b", runId: "r1", label: "skip-session" });
    Bus.publish(event, { sessionId: "a", label: "skip-no-runId" });
    await flush();

    expect(seen).toEqual(["match"]);
  });

  it("absent key never matches", async () => {
    const event = BusEvent.define<TestEvent>("test:absent", TestEventSchema);
    const seen: string[] = [];
    Bus.subscribe(
      event,
      (data) => {
        seen.push(data.label ?? "");
      },
      { match: { sessionId: "x" } },
    );

    Bus.publish(event, { runId: "r", label: "no-sessionId" });
    Bus.publish(event, { label: "empty" });
    await flush();

    expect(seen).toEqual([]);
  });

  it("empty match object fires all events", async () => {
    const event = BusEvent.define<TestEvent>("test:empty", TestEventSchema);
    const seen: string[] = [];
    Bus.subscribe(
      event,
      (data) => {
        seen.push(data.label ?? "");
      },
      { match: {} },
    );

    Bus.publish(event, { sessionId: "a", label: "p" });
    Bus.publish(event, { label: "q" });
    await flush();

    expect(seen).toEqual(["p", "q"]);
  });

  it("multiple subscribers with different match fire independently", async () => {
    const event = BusEvent.define<TestEvent>("test:multi", TestEventSchema);
    const seenA: string[] = [];
    const seenB: string[] = [];

    Bus.subscribe(
      event,
      (data) => {
        seenA.push(data.label ?? "");
      },
      { match: { sessionId: "A" } },
    );
    Bus.subscribe(
      event,
      (data) => {
        seenB.push(data.label ?? "");
      },
      { match: { sessionId: "B" } },
    );

    Bus.publish(event, { sessionId: "A", label: "alpha" });
    Bus.publish(event, { sessionId: "B", label: "bravo" });
    Bus.publish(event, { sessionId: "C", label: "charlie" });
    await flush();

    expect(seenA).toEqual(["alpha"]);
    expect(seenB).toEqual(["bravo"]);
  });

  it("unsubscribe still works under match filter", async () => {
    const event = BusEvent.define<TestEvent>("test:unsub", TestEventSchema);
    const seen: string[] = [];
    const unsub = Bus.subscribe(
      event,
      (data) => {
        seen.push(data.label ?? "");
      },
      { match: { sessionId: "x" } },
    );

    Bus.publish(event, { sessionId: "x", label: "first" });
    await flush();
    expect(seen).toEqual(["first"]);

    unsub();
    Bus.publish(event, { sessionId: "x", label: "second" });
    await flush();
    expect(seen).toEqual(["first"]);
  });

  it("type safety: invalid keys in match are rejected at compile time", () => {
    const event = BusEvent.define<TestEvent>("test:type", TestEventSchema);
    Bus.subscribe(event, () => {}, {
      // @ts-expect-error - 'invalidKey' is not a key of TestEvent
      match: { invalidKey: "z" },
    });
    expect(true).toBe(true);
  });
});
