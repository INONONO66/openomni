import { describe, expect, it } from "bun:test";

import { InjectionQueue } from "@openomni/openomni";
import { WorkerIpcHandlers } from "../../src/execution/worker-ipc-handlers";
import type { WorkerRunState } from "../../src/execution/worker-runner-types";

type ActiveRun = NonNullable<ReturnType<WorkerRunState.ActiveRunRegistry["get"]>>;

function createRun(sessionId: string): ActiveRun {
  return { sessionId, controller: new AbortController() };
}

describe("worker IPC handlers", () => {
  it("rejects unauthorized cancel requests without aborting the active run", () => {
    const run = createRun("session-1");
    const activeRuns = new Map([["run-1", run]]);

    const result = WorkerIpcHandlers.cancelRun({
      params: { authToken: "wrong", runId: "run-1" },
      ipcAuthToken: "token",
      activeRuns,
    });

    expect(result).toEqual({ cancelled: false, error: "unauthorized coordinator request" });
    expect(run.controller.signal.aborted).toBe(false);
  });

  it("aborts matching active runs", () => {
    const run = createRun("session-1");
    const activeRuns = new Map([["run-1", run]]);

    const result = WorkerIpcHandlers.cancelRun({
      params: { authToken: "token", runId: "run-1", sessionId: "session-1" },
      ipcAuthToken: "token",
      activeRuns,
    });

    expect(result).toEqual({ cancelled: true, runId: "run-1", sessionId: "session-1" });
    expect(run.controller.signal.aborted).toBe(true);
  });

  it("rejects cancel requests when session id does not match", () => {
    const run = createRun("session-1");
    const activeRuns = new Map([["run-1", run]]);

    const result = WorkerIpcHandlers.cancelRun({
      params: { authToken: "token", runId: "run-1", sessionId: "other-session" },
      ipcAuthToken: "token",
      activeRuns,
    });

    expect(result).toEqual({ cancelled: false, error: "run not active: run-1" });
    expect(run.controller.signal.aborted).toBe(false);
  });

  it("rejects unauthorized message delivery without queuing an injection", () => {
    const run = createRun("session-1");
    const activeRuns = new Map([["run-1", run]]);
    const injectionQueue = InjectionQueue.create();

    const result = WorkerIpcHandlers.deliverMessage({
      params: { authToken: "wrong", sessionId: "session-1", runId: "run-1", message: "new" },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns,
      injectionQueue,
    });

    expect(result).toEqual({ accepted: false, error: "unauthorized coordinator request" });
    expect(injectionQueue.hasPending("run-1")).toBe(false);
  });

  it("rejects message delivery when an explicit run id does not match", () => {
    const run = createRun("session-1");
    const activeRuns = new Map([["run-1", run]]);
    const injectionQueue = InjectionQueue.create();

    const result = WorkerIpcHandlers.deliverMessage({
      params: { authToken: "token", sessionId: "session-1", runId: "missing", message: "new" },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns,
      injectionQueue,
    });

    expect(result).toEqual({
      accepted: false,
      error: "run not active for session: session-1",
    });
    expect(injectionQueue.hasPending("missing")).toBe(false);
  });

  it("queues delivered messages for automatic prompt injection", () => {
    const run = createRun("session-1");
    const activeRuns = new Map([["run-1", run]]);
    const injectionQueue = InjectionQueue.create();

    const result = WorkerIpcHandlers.deliverMessage({
      params: { authToken: "token", sessionId: "session-1", runId: "run-1", message: "new" },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns,
      injectionQueue,
    });

    expect(result).toEqual({ accepted: true });
    expect(injectionQueue.drain("run-1")).toEqual([
      {
        messageId: expect.any(String),
        output: "new",
        timestamp: expect.any(Number),
      },
    ]);
  });

  it("requires a run id before queuing message injections", () => {
    const run = createRun("session-1");
    const activeRuns = new Map([["run-1", run]]);
    const injectionQueue = InjectionQueue.create();

    const result = WorkerIpcHandlers.deliverMessage({
      params: { authToken: "token", sessionId: "session-1", message: "new" },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns,
      injectionQueue,
    });

    expect(result).toEqual({
      accepted: false,
      error: "run not active for session: session-1",
    });
    expect(injectionQueue.hasPending("run-1")).toBe(false);
  });

  it("reports idle shutdown readiness only when authorized and idle", () => {
    expect(
      WorkerIpcHandlers.canShutdownIdle({
        params: { authToken: "wrong" },
        ipcAuthToken: "token",
        activeRuns: new Map(),
      }),
    ).toEqual({ acknowledged: false, error: "unauthorized coordinator request" });

    expect(
      WorkerIpcHandlers.canShutdownIdle({
        params: { authToken: "token" },
        ipcAuthToken: "token",
        activeRuns: new Map([["run-1", createRun("session-1")]]),
      }),
    ).toEqual({ acknowledged: false, error: "worker is busy" });

    expect(
      WorkerIpcHandlers.canShutdownIdle({
        params: { authToken: "token" },
        ipcAuthToken: "token",
        activeRuns: new Map(),
      }),
    ).toEqual({ acknowledged: true });
  });

  it("rejects unauthorized tool-settled notifications without clearing unsafe markers", () => {
    const cleared: Array<{ workspaceRoot: string; callId: string }> = [];

    const result = WorkerIpcHandlers.toolCallSettled({
      params: { authToken: "wrong", workspaceRoot: "/workspace", callId: "call-1" },
      ipcAuthToken: "token",
      clearUnsafe: (workspaceRoot, callId) => cleared.push({ workspaceRoot, callId }),
    });

    expect(result).toEqual({
      acknowledged: false,
      error: "unauthorized coordinator request",
    });
    expect(cleared).toEqual([]);
  });

  it("rejects malformed tool-settled notifications without acknowledging success", () => {
    const cleared: Array<{ workspaceRoot: string; callId: string }> = [];

    const result = WorkerIpcHandlers.toolCallSettled({
      params: { authToken: "token", callId: "call-1" },
      ipcAuthToken: "token",
      clearUnsafe: (workspaceRoot, callId) => cleared.push({ workspaceRoot, callId }),
    });

    expect(result).toEqual({
      acknowledged: false,
      error: "invalid worker.tool_call_settled params",
    });
    expect(cleared).toEqual([]);
  });

  it("clears unsafe markers for authorized tool-settled notifications", () => {
    const cleared: Array<{ workspaceRoot: string; callId: string }> = [];

    const result = WorkerIpcHandlers.toolCallSettled({
      params: { authToken: "token", workspaceRoot: "/workspace", callId: "call-1" },
      ipcAuthToken: "token",
      clearUnsafe: (workspaceRoot, callId) => cleared.push({ workspaceRoot, callId }),
    });

    expect(result).toEqual({ acknowledged: true });
    expect(cleared).toEqual([{ workspaceRoot: "/workspace", callId: "call-1" }]);
  });

  it("rejects tool-settled notifications when clearing unsafe markers fails", () => {
    const result = WorkerIpcHandlers.toolCallSettled({
      params: { authToken: "token", workspaceRoot: "/workspace", callId: "call-1" },
      ipcAuthToken: "token",
      clearUnsafe: () => {
        throw new Error("disk unavailable");
      },
    });

    expect(result).toEqual({
      acknowledged: false,
      error: "failed to clear unsafe marker: disk unavailable",
    });
  });
});
