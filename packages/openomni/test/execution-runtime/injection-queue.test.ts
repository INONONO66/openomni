import { describe, expect, it } from "bun:test";
import { InjectionQueue } from "../../src/execution-runtime/injection-queue.js";

describe("InjectionQueue", () => {
  it("drains responses in FIFO order and clears pending state", () => {
    const queue = InjectionQueue.create();

    queue.enqueue("run-1", {
      messageId: "m-1",
      output: "first",
      timestamp: 1,
    });
    queue.enqueue("run-1", {
      messageId: "m-2",
      output: "second",
      injectToHistory: true,
      timestamp: 2,
    });

    expect(queue.hasPending("run-1")).toBe(true);

    const drained = queue.drain("run-1");

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
    expect(queue.drain("run-1")).toEqual([]);
  });

  it("keeps run queues isolated and dispose removes all state", () => {
    const queue = InjectionQueue.create();

    queue.enqueue("run-a", { messageId: "a-1", output: "alpha", timestamp: 10 });
    queue.enqueue("run-b", { messageId: "b-1", output: "beta", timestamp: 11 });

    queue.dispose("run-a");

    expect(queue.hasPending("run-a")).toBe(false);
    expect(queue.drain("run-a")).toEqual([]);
    expect(queue.hasPending("run-b")).toBe(true);
    expect(queue.drain("run-b")).toEqual([{ messageId: "b-1", output: "beta", timestamp: 11 }]);
    expect(queue.hasPending("run-b")).toBe(false);
  });
});
