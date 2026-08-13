import { describe, expect, it } from "bun:test";

import { WorkerRunner } from "../../src/execution/worker-runner";
import {
  type ActiveRun,
  createSpawnOptions,
  createValidRequest,
  successfulResult,
} from "./worker-runner-fixture";

describe("WorkerRunner", () => {
  it("rejects unauthorized spawn requests without starting a run", () => {
    const responses: unknown[] = [];
    const options = createSpawnOptions(
      {
        authToken: "wrong",
        runId: "run-1",
        sessionId: "session-1",
      },
      (result) => responses.push(result),
    );

    WorkerRunner.spawnRun(options);

    expect(responses).toEqual([
      {
        runId: "run-1",
        sessionId: "session-1",
        status: "failed",
        error: "unauthorized coordinator request",
      },
    ]);
    expect(options.activeRuns.size).toBe(0);
  });

  /**
   * A worker run inherits the trace of the dispatch that ordered it, so the
   * requirement lives in `Execution.Request` and the existing parse rejection
   * answers the coordinator. A guard placed after `parse` would instead reject
   * into the void: `spawnRun` discards its async body's promise, so the caller
   * would wait for a frame that never arrives.
   */
  it("rejects a traceless spawn request through the parse path", () => {
    const responses: Array<{ readonly error?: string }> = [];
    const { traceId: _dropped, ...traceless } = createValidRequest();
    const options = createSpawnOptions(traceless, (result) =>
      responses.push(result as { readonly error?: string }),
    );

    WorkerRunner.spawnRun(options);

    expect(responses).toHaveLength(1);
    expect(responses[0]?.error).toContain("traceId");
    expect(options.activeRuns.size).toBe(0);
  });

  it("rejects malformed spawn requests before starting a run", () => {
    const responses: unknown[] = [];
    const options = createSpawnOptions(
      {
        authToken: "token",
        runId: "run-1",
        sessionId: "session-1",
      },
      (result) => responses.push(result),
    );

    WorkerRunner.spawnRun(options);

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
      status: "failed",
    });
    expect(options.activeRuns.size).toBe(0);
  });

  it("rejects duplicate run ids without replacing the active run", () => {
    const responses: unknown[] = [];
    const existingRun: ActiveRun = {
      sessionId: "session-1",
      controller: new AbortController(),
    };
    const activeRuns = new Map([["run-1", existingRun]]);
    const options = createSpawnOptions(createValidRequest(), (result) => responses.push(result), {
      activeRuns,
    });

    WorkerRunner.spawnRun(options);

    expect(responses).toEqual([
      {
        runId: "run-1",
        sessionId: "session-1",
        status: "failed",
        error: "run already active: run-1",
      },
    ]);
    expect(activeRuns.get("run-1")).toBe(existingRun);
  });

  it("runs valid spawn requests and cleans active run state after success", async () => {
    const responses: unknown[] = [];
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const activeRuns = new Map();
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        createValidRequest(),
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          activeRuns,
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify(method, params) {
              notifications.push({ method, params });
            },
          },
          createAgent: () => ({
            async run(input) {
              expect(activeRuns.get("run-1")?.sessionId).toBe("session-1");
              expect(input.traceContext).toEqual({
                traceId: expect.any(String),
                sessionId: "session-1",
                runId: "run-1",
              });
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses).toEqual([
      {
        runId: "run-1",
        sessionId: "session-1",
        status: "succeeded",
        output: "done",
        finishReason: "stop",
      },
    ]);
    expect(notifications).toEqual([]);
    expect(activeRuns.size).toBe(0);
  });

  it("reports failed runs and cleans active run state after agent errors", async () => {
    const responses: unknown[] = [];
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const activeRuns = new Map();
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        createValidRequest(),
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          activeRuns,
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify(method, params) {
              notifications.push({ method, params });
            },
          },
          createAgent: () => ({
            async run() {
              throw new Error("agent failed");
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses).toEqual([
      {
        runId: "run-1",
        sessionId: "session-1",
        status: "failed",
        error: "agent failed",
      },
    ]);
    expect(notifications).toEqual([]);
    expect(activeRuns.size).toBe(0);
  });
});
