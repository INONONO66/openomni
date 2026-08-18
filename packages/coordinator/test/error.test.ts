import { describe, expect, test } from "bun:test";
import { WorkerDeliveryError } from "../src/error";

// #500 C3: moved from packages/protocol/test/worker-driver-event.test.ts with
// the error type — the taxonomy lives with its throwers now.
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
