import { describe, expect, test } from "bun:test";
import { Worker } from "../src/index.js";

const settledBase = {
  traceId: "trace-1",
  time: 1,
  workerId: 0,
  runId: "run-1",
  sessionId: "session-1",
  durationMs: 5,
};

describe("Worker.Events.RunSettled outcome", () => {
  test.each([
    "completed",
    "interrupted",
    "error",
    "cancelled",
  ] as const)("accepts outcome %s", (outcome) => {
    expect(Worker.Events.RunSettled.schema.safeParse({ ...settledBase, outcome }).success).toBe(
      true,
    );
  });

  test("rejects outcomes outside the enum", () => {
    expect(
      Worker.Events.RunSettled.schema.safeParse({ ...settledBase, outcome: "aborted" }).success,
    ).toBe(false);
  });
});

// #500 C3: the WorkerDeliveryError taxonomy suite moved to
// packages/coordinator/test/error.test.ts with the error type.
