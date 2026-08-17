import { describe, expect, test } from "bun:test";
import { WorkerDeliveryError, WorkerDriver } from "../src/index.js";

const settledBase = {
  traceId: "trace-1",
  time: 1,
  workerId: 0,
  runId: "run-1",
  sessionId: "session-1",
  durationMs: 5,
};

describe("WorkerDriver.RunSettled outcome", () => {
  test.each([
    "completed",
    "interrupted",
    "error",
    "cancelled",
  ] as const)("accepts outcome %s", (outcome) => {
    expect(WorkerDriver.RunSettled.schema.safeParse({ ...settledBase, outcome }).success).toBe(
      true,
    );
  });

  test("rejects outcomes outside the enum", () => {
    expect(
      WorkerDriver.RunSettled.schema.safeParse({ ...settledBase, outcome: "aborted" }).success,
    ).toBe(false);
  });
});

describe("WorkerDeliveryError codes", () => {
  test.each([
    "worker_unavailable",
    "worker_not_ready",
    "worker_stopped",
    "ipc_connection_lost",
  ] as const)("supervisor rejection code %s is part of the taxonomy", (code) => {
    const error = new WorkerDeliveryError({ message: "m", code });
    expect(WorkerDeliveryError.Schema.safeParse(error.toObject()).success).toBe(true);
  });
});
