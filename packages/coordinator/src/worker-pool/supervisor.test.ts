import { describe, test, expect, mock } from "bun:test";
import type { IpcClient } from "../ipc/client";
import { WorkerSupervisor } from "./supervisor";

describe("WorkerSupervisor dispatch timeout ceiling", () => {
  function createTestSupervisor(mockClient: IpcClient): WorkerSupervisor {
    const supervisor = Object.create(WorkerSupervisor.prototype) as WorkerSupervisor;
    Reflect.set(supervisor, "client", mockClient);
    return supervisor;
  }

  test("dispatch timeout is capped at 600_000 ms when budget.maxWallTimeMs is Infinity", async () => {
    let capturedTimeoutMs: number | undefined;
    const mockClient: IpcClient = {
      connected: true,
      call: mock(async (_method: string, _params: unknown, timeoutMs: number) => {
        capturedTimeoutMs = timeoutMs;
        return { success: true };
      }),
      close: () => undefined,
    };

    const supervisor = createTestSupervisor(mockClient);
    const params = {
      budget: {
        maxWallTimeMs: Infinity,
      },
    };

    await supervisor.dispatch("test-run-id", params);

    expect(capturedTimeoutMs).toBe(600_000);
  });

  test("dispatch timeout respects minimum of 330_000 ms for low budget", async () => {
    let capturedTimeoutMs: number | undefined;
    const mockClient: IpcClient = {
      connected: true,
      call: mock(async (_method: string, _params: unknown, timeoutMs: number) => {
        capturedTimeoutMs = timeoutMs;
        return { success: true };
      }),
      close: () => undefined,
    };

    const supervisor = createTestSupervisor(mockClient);
    const params = {
      budget: {
        maxWallTimeMs: 100_000,
      },
    };

    await supervisor.dispatch("test-run-id", params);

    // Math.max(100_000, 300_000) + 30_000 = 330_000
    expect(capturedTimeoutMs).toBe(330_000);
  });

  test("dispatch timeout is capped at 600_000 ms for large budgets", async () => {
    let capturedTimeoutMs: number | undefined;
    const mockClient: IpcClient = {
      connected: true,
      call: mock(async (_method: string, _params: unknown, timeoutMs: number) => {
        capturedTimeoutMs = timeoutMs;
        return { success: true };
      }),
      close: () => undefined,
    };

    const supervisor = createTestSupervisor(mockClient);
    const params = {
      budget: {
        maxWallTimeMs: 1_000_000,
      },
    };

    await supervisor.dispatch("test-run-id", params);

    // Math.max(1_000_000, 300_000) + 30_000 = 1_030_000, capped at 600_000
    expect(capturedTimeoutMs).toBe(600_000);
  });

  test("dispatch timeout respects minimum of 330_000 ms when budget is missing", async () => {
    let capturedTimeoutMs: number | undefined;
    const mockClient: IpcClient = {
      connected: true,
      call: mock(async (_method: string, _params: unknown, timeoutMs: number) => {
        capturedTimeoutMs = timeoutMs;
        return { success: true };
      }),
      close: () => undefined,
    };

    const supervisor = createTestSupervisor(mockClient);
    const params = {};

    await supervisor.dispatch("test-run-id", params);

    // Math.max(300_000, 300_000) + 30_000 = 330_000
    expect(capturedTimeoutMs).toBe(330_000);
  });
});
