import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { WorkerManager } from "@openomni/coordinator";
import { WorkerDeliveryError, type Execution } from "@openomni/protocol";
import { createExecutionCoordinator } from "../../src/execution/coordinator";

let mockWorkerManager: WorkerManager;

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockWorkerManager = {
    deliver(_runId, params) {
      if (typeof params.delayMs !== "number") {
        return Promise.reject(new Error("coordinator test worker requires numeric delayMs"));
      }
      const deferred = createDeferred<unknown>();
      setTimeout(() => {
        deferred.resolve({
          runId: params.runId,
          sessionId: params.sessionId,
          status: "succeeded",
          output: `fixture:${String(params.runId)}`,
          finishReason: "stop",
        });
      }, params.delayMs);
      return deferred.promise;
    },
    async send() {
      return { ok: true };
    },
    async cancel() {
      return { ok: true };
    },
    stats() {
      return { workers: 1, active: 1, idle: 0, ready: 1, activeRuns: 0, maxActiveWorkers: 1 };
    },
    async waitUntilReady() {
      /* no-op */
    },
    async shutdown() {
      /* no-op */
    },
  };
});

function makeRequest(overrides: Partial<Execution.Request> = {}): Execution.Request {
  return {
    traceId: "trace-fixture",
    runId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    mode: "direct",
    prompt: "hello",
    model: { provider: "test", id: "fixture" },
    ...overrides,
  };
}

describe("ExecutionCoordinator", () => {
  test("waitUntilReady delegates to the worker manager", async () => {
    const waitUntilReady = mock(async () => undefined);
    mockWorkerManager.waitUntilReady = waitUntilReady;

    const coordinator = createExecutionCoordinator({
      workerScript: "unused-in-test",
      maxWorkers: 1,
      workerManagerFactory: () => mockWorkerManager,
    });

    await coordinator.waitUntilReady(1_234);

    expect(waitUntilReady).toHaveBeenCalledWith(1_234);
  });

  test("rejects new dispatches once shutdown begins while allowing active runs to finish", async () => {
    const activeRun = createDeferred<Execution.Result>();
    let activeRuns = 1;
    const managerShutdown = mock(async () => undefined);
    mockWorkerManager.deliver = () =>
      activeRun.promise.finally(() => {
        activeRuns = 0;
      });
    mockWorkerManager.stats = () => ({
      workers: 1,
      active: activeRuns,
      idle: activeRuns === 0 ? 1 : 0,
      ready: 1,
      activeRuns,
      maxActiveWorkers: 1,
    });
    mockWorkerManager.shutdown = managerShutdown;
    const coordinator = createExecutionCoordinator({
      workerScript: "unused-in-test",
      maxWorkers: 1,
      workerManagerFactory: () => mockWorkerManager,
    });

    const firstRun = coordinator.dispatch(
      "session-1",
      makeRequest({
        runId: "run-1",
        sessionId: "session-1",
        prompt: "long",
      }),
    );

    const shutdown = coordinator.shutdown();
    expect(managerShutdown).not.toHaveBeenCalled();

    try {
      await coordinator.dispatch(
        "session-2",
        makeRequest({ runId: "run-2", sessionId: "session-2", prompt: "blocked" }),
      );
      throw new Error("expected dispatch to reject");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("Execution coordinator is draining");
    }

    activeRun.resolve({
      runId: "run-1",
      sessionId: "session-1",
      status: "succeeded",
      output: "fixture:run-1",
      finishReason: "stop",
    });
    expect(await firstRun).toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
      status: "succeeded",
    });

    await shutdown;
    expect(managerShutdown).toHaveBeenCalledTimes(1);
  });

  test("rejects a dispatch whose sessionTreeId diverges from request.sessionId", async () => {
    const coordinator = createExecutionCoordinator({
      workerScript: "unused-in-test",
      maxWorkers: 1,
      workerManagerFactory: () => mockWorkerManager,
    });

    try {
      await coordinator.dispatch(
        "tree-other",
        makeRequest({ runId: "run-mismatch", sessionId: "session-mismatch" }),
      );
      throw new Error("expected dispatch to reject");
    } catch (error) {
      if (!WorkerDeliveryError.isInstance(error)) throw error;
      expect(error.data.code).toBe("session_mismatch");
    }
  });
});
