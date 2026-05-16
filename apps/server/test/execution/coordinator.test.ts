import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Execution } from "@openomni/protocol";

type MockWorkerManager = {
  dispatch(sessionId: string, runId: string, params: Record<string, unknown>): Promise<unknown>;
  getStats(): {
    workers: number;
    active: number;
    idle: number;
    ready: number;
    busy: number;
    maxWorkers: number;
  };
  waitUntilReady(timeoutMs?: number): Promise<void>;
  shutdown(): Promise<void>;
};

let mockWorkerManager: MockWorkerManager;

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

mock.module("@openomni/coordinator", () => ({
  createWorkerManager: () => mockWorkerManager,
  recoverInterruptedRuns: async () => ({ recovered: 0, sessions: [] }),
}));

let createExecutionCoordinator: typeof import("../../src/execution/coordinator").createExecutionCoordinator;

beforeAll(async () => {
  ({ createExecutionCoordinator } = await import("../../src/execution/coordinator"));
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  mockWorkerManager = {
    dispatch(_sessionId, _runId, params) {
      const deferred = createDeferred<unknown>();
      if (typeof params.delayMs === "number") {
        setTimeout(() => {
          deferred.resolve({
            runId: params.runId,
            sessionId: params.sessionId,
            status: "succeeded",
            output: `fixture:${String(params.runId)}`,
            finishReason: "stop",
          });
        }, params.delayMs);
      }
      return deferred.promise;
    },
    getStats() {
      return { workers: 1, active: 1, idle: 0, ready: 1, busy: 0, maxWorkers: 1 };
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
    runId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    mode: "direct",
    prompt: "hello",
    model: { provider: "test", id: "fixture" },
    ...overrides,
  };
}

describe("ExecutionCoordinator", () => {
  test("waitUntilReady delegates to the worker pool", async () => {
    const waitUntilReady = mock(async () => undefined);
    mockWorkerManager.waitUntilReady = waitUntilReady;

    const coordinator = createExecutionCoordinator({
      workerScript: "unused-in-test",
      workerCount: 1,
    });

    await coordinator.waitUntilReady(1_234);

    expect(waitUntilReady).toHaveBeenCalledWith(1_234);
  });

  test("rejects new dispatches once shutdown begins while allowing active runs to finish", async () => {
    const coordinator = createExecutionCoordinator({
      workerScript: "unused-in-test",
      workerCount: 1,
    });

    const firstRun = coordinator.dispatch(
      "tree-1",
      makeRequest({
        runId: "run-1",
        sessionId: "session-1",
        prompt: "long",
        delayMs: 150,
      } as never),
    );

    const shutdown = coordinator.shutdown();

    await expect(
      coordinator.dispatch(
        "tree-2",
        makeRequest({ runId: "run-2", sessionId: "session-2", prompt: "blocked" }),
      ),
    ).rejects.toThrow("Execution coordinator is draining");

    await expect(firstRun).resolves.toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
      status: "succeeded",
    });

    await shutdown;
  });
});
