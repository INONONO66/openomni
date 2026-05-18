import { describe, expect, it } from "bun:test";

import { WorkerIpcHandlers } from "../../src/execution/worker-ipc-handlers";
import type { WorkerRunState } from "../../src/execution/worker-run-state";

function createRun(sessionId: string, inbox: string[] = []): WorkerRunState.ActiveRun {
  return { sessionId, controller: new AbortController(), inbox };
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

  it("rejects unauthorized message delivery without mutating the inbox", () => {
    const run = createRun("session-1", ["existing"]);
    const activeRuns = new Map([["run-1", run]]);

    const result = WorkerIpcHandlers.deliverMessage({
      params: { authToken: "wrong", sessionId: "session-1", runId: "run-1", message: "new" },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns,
    });

    expect(result).toEqual({ accepted: false, error: "unauthorized coordinator request" });
    expect(run.inbox).toEqual(["existing"]);
  });

  it("rejects message delivery when an explicit run id does not match", () => {
    const run = createRun("session-1", []);
    const activeRuns = new Map([["run-1", run]]);

    const result = WorkerIpcHandlers.deliverMessage({
      params: { authToken: "token", sessionId: "session-1", runId: "missing", message: "new" },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns,
    });

    expect(result).toEqual({
      accepted: false,
      error: "run not active for session: session-1",
    });
    expect(run.inbox).toEqual([]);
  });

  it("delivers messages to a matching active run and caps inbox depth", () => {
    const run = createRun("session-1", ["oldest", "older", "old"]);
    const activeRuns = new Map([["run-1", run]]);

    const result = WorkerIpcHandlers.deliverMessage({
      params: { authToken: "token", sessionId: "session-1", runId: "run-1", message: "new" },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns,
      maxInboxMessages: 2,
    });

    expect(result).toEqual({ accepted: true });
    expect(run.inbox).toEqual(["old", "new"]);
  });

  it("falls back to the default inbox cap for invalid numeric caps", () => {
    const seedInbox = Array.from({ length: 100 }, (_, index) => `message-${index}`);
    const run = createRun("session-1", seedInbox);
    const activeRuns = new Map([["run-1", run]]);

    const result = WorkerIpcHandlers.deliverMessage({
      params: { authToken: "token", sessionId: "session-1", runId: "run-1", message: "new" },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns,
      maxInboxMessages: Number.NaN,
    });

    expect(result).toEqual({ accepted: true });
    expect(run.inbox).toHaveLength(100);
    expect(run.inbox[0]).toBe("message-1");
    expect(run.inbox.at(-1)).toBe("new");
  });

  it("rejects ambiguous session-only delivery when multiple runs are active", () => {
    const activeRuns = new Map([
      ["run-1", createRun("session-1")],
      ["run-2", createRun("session-1")],
    ]);

    const result = WorkerIpcHandlers.deliverMessage({
      params: { authToken: "token", sessionId: "session-1", message: "hello" },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns,
    });

    expect(result).toEqual({
      accepted: false,
      error: "multiple active runs for session: session-1",
    });
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
});
