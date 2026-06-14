import { describe, expect, it, mock } from "bun:test";

import { WorkerHeartbeat } from "../../src/execution/worker-heartbeat";

describe("worker heartbeat", () => {
  interface TimerRef {
    current?: ReturnType<typeof setInterval>;
  }

  it("creates worker snapshots from active run state", () => {
    const snapshot = WorkerHeartbeat.createSnapshot({
      activeRunIds: ["run-1", "run-2"],
      configEpoch: "epoch-1",
      memoryRssMb: 12.5,
      lastHeartbeat: 123,
    });

    expect(snapshot).toEqual({
      activeRuns: ["run-1", "run-2"],
      backgroundTasks: [],
      lastHeartbeat: 123,
      memoryRss: 12.5,
      configEpoch: "epoch-1",
    });
  });

  it("sends heartbeat payloads through the interval entrypoint", async () => {
    const timer: TimerRef = {};
    const serverCall = mock(async () => ({ ok: true }));
    const callObserved = new Promise<void>((resolve) => {
      serverCall.mockImplementation(async () => {
        if (timer.current) clearInterval(timer.current);
        resolve();
        return { ok: true };
      });
    });

    timer.current = WorkerHeartbeat.start({
      workerId: "worker-1",
      ipcAuthToken: "token",
      server: { call: serverCall },
      getActiveRunIds: () => ["run-1"],
      getConfigEpoch: () => "epoch-1",
      readMemoryRssMb: () => 10,
      nowMs: () => 123,
      intervalMs: 1,
    });

    await callObserved;

    expect(serverCall).toHaveBeenCalledTimes(1);
    expect(serverCall).toHaveBeenCalledWith("worker.heartbeat", {
      workerId: "worker-1",
      authToken: "token",
      activeRunIds: ["run-1"],
      memoryRssMb: 10,
      snapshot: {
        activeRuns: ["run-1"],
        backgroundTasks: [],
        lastHeartbeat: 123,
        memoryRss: 10,
        configEpoch: "epoch-1",
      },
    });
  });

  it("ignores supervisor send failures", async () => {
    const timer: TimerRef = {};
    const serverCall = mock(async () => {
      throw new Error("not connected yet");
    });
    const callObserved = new Promise<void>((resolve) => {
      serverCall.mockImplementation(async () => {
        if (timer.current) clearInterval(timer.current);
        resolve();
        throw new Error("not connected yet");
      });
    });

    timer.current = WorkerHeartbeat.start({
      workerId: "worker-1",
      ipcAuthToken: "token",
      server: { call: serverCall },
      getActiveRunIds: () => ["run-1"],
      getConfigEpoch: () => "epoch-1",
      readMemoryRssMb: () => 10,
      nowMs: () => 123,
      intervalMs: 1,
    });

    await callObserved;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(serverCall).toHaveBeenCalledTimes(1);
  });
});
