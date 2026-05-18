import { describe, expect, it, mock } from "bun:test";

import { WorkerHeartbeat } from "../../src/execution/worker-heartbeat";

describe("worker heartbeat", () => {
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

  it("sends heartbeat payloads", async () => {
    const serverCall = mock(async () => ({ ok: true }));

    await WorkerHeartbeat.send({
      workerId: "worker-1",
      ipcAuthToken: "token",
      server: { call: serverCall },
      getActiveRunIds: () => ["run-1"],
      getConfigEpoch: () => "epoch-1",
      readMemoryRssMb: () => 10,
      nowMs: () => 123,
    });

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
    const serverCall = mock(async () => {
      throw new Error("not connected yet");
    });

    await expect(
      WorkerHeartbeat.send({
        workerId: "worker-1",
        ipcAuthToken: "token",
        server: { call: serverCall },
        getActiveRunIds: () => ["run-1"],
        getConfigEpoch: () => "epoch-1",
        readMemoryRssMb: () => 10,
        nowMs: () => 123,
      }),
    ).resolves.toBeUndefined();
  });
});
