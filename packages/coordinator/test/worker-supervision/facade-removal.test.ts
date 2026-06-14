import { describe, expect, test } from "bun:test";

describe("worker supervision public facade removal", () => {
  test("root coordinator barrel exposes the worker manager without legacy pool internals", async () => {
    const coordinator = await import("../../src/index");

    expect("createWorkerPool" in coordinator).toBe(false);
    expect("WorkerSupervisor" in coordinator).toBe(false);
    expect("createSessionRouting" in coordinator).toBe(false);
    expect("SessionRouting" in coordinator).toBe(false);
    expect("createWorkerManager" in coordinator).toBe(true);
  });
});
