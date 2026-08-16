import { describe, expect, it } from "bun:test";
import { Bus } from "@openomni/telemetry";
import { InjectionQueue } from "../../src/execution-runtime/injection-queue.js";

describe("InjectionQueue", () => {
  it("queue events inherit their callers' traces and carry occurrence time (D11)", async () => {
    const queue = InjectionQueue.create();
    const traced: Array<Record<string, unknown>> = [];
    Bus.observe((event, data) => {
      if (event.name.startsWith("injection_queue.")) traced.push(data as Record<string, unknown>);
    });

    queue.enqueue(
      "run-traced",
      { messageId: "m-traced", output: "payload", timestamp: 7 },
      "trace-enqueue",
    );
    queue.drain("run-traced", "trace-drain");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(traced).toEqual([
      // `time`, not `timestamp`: the persistence reader keys occurrence time
      // off a `time` field and fell back to its own wall clock before.
      { runId: "run-traced", traceId: "trace-enqueue", messageId: "m-traced", time: 7 },
      {
        runId: "run-traced",
        traceId: "trace-drain",
        count: 1,
        time: expect.any(Number),
      },
    ]);
  });

  it("drains responses in FIFO order and clears pending state", () => {
    const queue = InjectionQueue.create();

    queue.enqueue(
      "run-1",
      {
        messageId: "m-1",
        output: "first",
        timestamp: 1,
      },
      "trace-queue-test",
    );
    queue.enqueue(
      "run-1",
      {
        messageId: "m-2",
        output: "second",
        injectToHistory: true,
        timestamp: 2,
      },
      "trace-queue-test",
    );

    expect(queue.hasPending("run-1")).toBe(true);

    const drained = queue.drain("run-1", "trace-queue-test");

    expect(drained).toEqual([
      {
        messageId: "m-1",
        output: "first",
        timestamp: 1,
      },
      {
        messageId: "m-2",
        output: "second",
        injectToHistory: true,
        timestamp: 2,
      },
    ]);
    expect(queue.hasPending("run-1")).toBe(false);
    expect(queue.drain("run-1", "trace-queue-test")).toEqual([]);
  });

  it("keeps run queues isolated and dispose removes all state", () => {
    const queue = InjectionQueue.create();

    queue.enqueue(
      "run-a",
      { messageId: "a-1", output: "alpha", timestamp: 10 },
      "trace-queue-test",
    );
    queue.enqueue("run-b", { messageId: "b-1", output: "beta", timestamp: 11 }, "trace-queue-test");

    queue.dispose("run-a");

    expect(queue.hasPending("run-a")).toBe(false);
    expect(queue.drain("run-a", "trace-queue-test")).toEqual([]);
    expect(queue.hasPending("run-b")).toBe(true);
    expect(queue.drain("run-b", "trace-queue-test")).toEqual([
      { messageId: "b-1", output: "beta", timestamp: 11 },
    ]);
    expect(queue.hasPending("run-b")).toBe(false);
  });
});
