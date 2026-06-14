import { describe, expect, test } from "bun:test";

describe("worker pool public facade removal", () => {
  test("root coordinator barrel no longer exports the legacy WorkerPool facade", async () => {
    const coordinator = await import("../../src/index");

    expect("createWorkerPool" in coordinator).toBe(false);
    expect("createWorkerManager" in coordinator).toBe(true);
  });

  test("worker-pool barrel keeps shared internals without the legacy facade", async () => {
    const workerPool = await import("../../src/worker-pool");

    expect("createWorkerPool" in workerPool).toBe(false);
    expect("WorkerSupervisor" in workerPool).toBe(true);
    expect("SessionRouting" in workerPool).toBe(false);
    expect("createSessionRouting" in workerPool).toBe(true);
  });
});
