import { afterEach, describe, expect, mock, test } from "bun:test";
import { type BusEvent, Operational, WorkerDeliveryError } from "@openomni/protocol";
import { IpcConnectionError, type IpcClient } from "@openomni/ipc";
import { WorkerSupervisor } from "./supervisor";

const originalStopGraceMs = process.env.OPENOMNI_WORKER_STOP_GRACE_MS;

afterEach(() => {
  if (originalStopGraceMs === undefined) {
    delete process.env.OPENOMNI_WORKER_STOP_GRACE_MS;
  } else {
    process.env.OPENOMNI_WORKER_STOP_GRACE_MS = originalStopGraceMs;
  }
});

describe("WorkerSupervisor deliver timeout ceiling", () => {
  function createTestSupervisor(mockClient: IpcClient): WorkerSupervisor {
    const supervisor = Object.create(WorkerSupervisor.prototype) as WorkerSupervisor;
    Reflect.set(supervisor, "client", mockClient);
    return supervisor;
  }

  test("deliver timeout is capped at 600_000 ms when budget.maxWallTimeMs is Infinity", async () => {
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
      traceId: "trace-test",
      budget: {
        maxWallTimeMs: Infinity,
      },
    };

    await supervisor.deliver("test-run-id", params);

    expect(capturedTimeoutMs).toBe(600_000);
  });

  test("wall-time ceiling is budget plus margin (no floor — #462 step 5)", async () => {
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
      traceId: "trace-test",
      budget: {
        maxWallTimeMs: 100_000,
      },
    };

    await supervisor.deliver("test-run-id", params);

    // 100_000 + 30_000 margin = 130_000 — the driver kills at budget+margin,
    // it no longer floors small budgets at 300s (#462 §4 wall-time physics).
    expect(capturedTimeoutMs).toBe(130_000);
  });

  test("deliver timeout is capped at 600_000 ms for large budgets", async () => {
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
      traceId: "trace-test",
      budget: {
        maxWallTimeMs: 1_000_000,
      },
    };

    await supervisor.deliver("test-run-id", params);

    // 1_000_000 + 30_000 margin — a finite positive budget is honored above
    // the backstop so the driver never kills a run the loop still allows.
    expect(capturedTimeoutMs).toBe(1_030_000);
  });

  test("unlimited budget (-1 sentinel) gets the 600_000 ms physics backstop", async () => {
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
      traceId: "trace-test",
      budget: {
        maxWallTimeMs: -1,
      },
    };

    await supervisor.deliver("test-run-id", params);

    // -1 means unlimited (AgentBudget): the loop will never stop the run, so
    // the driver backstop must — and must NOT collapse to margin-only ~30s.
    expect(capturedTimeoutMs).toBe(600_000);
  });

  test("missing budget gets the 600_000 ms physics backstop", async () => {
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
    const params = { traceId: "trace-test" };

    await supervisor.deliver("test-run-id", params);

    // No budget declared → nothing in the loop bounds the run → the driver
    // backstop is the only wall-time bound.
    expect(capturedTimeoutMs).toBe(600_000);
  });

  test("budget.maxWallTimeMs=120_000 passes timeout=150_000 to the IPC call", async () => {
    // Replaces the dispatch.test theater that claimed this assertion while
    // only checking accepted===true: the spy IS the IPC edge here.
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

    await supervisor.deliver("test-run-id", {
      traceId: "trace-test",
      budget: { maxWallTimeMs: 120_000 },
    });

    expect(capturedTimeoutMs).toBe(150_000);
  });
});

describe("WorkerSupervisor typed rejections (#audit M6)", () => {
  function createTestSupervisor(client: IpcClient | null): WorkerSupervisor {
    const supervisor = Object.create(WorkerSupervisor.prototype) as WorkerSupervisor;
    Reflect.set(supervisor, "id", 7);
    Reflect.set(supervisor, "client", client);
    return supervisor;
  }

  test("deliver without a connected client rejects with worker_unavailable", async () => {
    const supervisor = createTestSupervisor(null);

    try {
      await supervisor.deliver("run-x", { traceId: "trace-test", sessionId: "session-x" });
      throw new Error("expected deliver to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerDeliveryError);
      const typed = error as InstanceType<typeof WorkerDeliveryError>;
      expect(typed.data).toMatchObject({
        code: "worker_unavailable",
        runId: "run-x",
        sessionId: "session-x",
      });
    }
  });

  test("a raw IpcConnectionError from the transport rejects as ipc_connection_lost", async () => {
    const cause = new IpcConnectionError("socket closed");
    const mockClient: IpcClient = {
      connected: true,
      call: mock(async () => {
        throw cause;
      }),
      close: () => undefined,
    };
    const supervisor = createTestSupervisor(mockClient);

    try {
      await supervisor.deliver("run-y", { traceId: "trace-test", sessionId: "session-y" });
      throw new Error("expected deliver to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerDeliveryError);
      const typed = error as InstanceType<typeof WorkerDeliveryError>;
      expect(typed.data).toMatchObject({
        code: "ipc_connection_lost",
        runId: "run-y",
        sessionId: "session-y",
      });
      expect((typed as Error & { cause?: unknown }).cause).toBe(cause);
    }
  });
});

describe("WorkerSupervisor stop", () => {
  function createStopSupervisor(
    proc: {
      kill: (signal: NodeJS.Signals) => void;
      exited: Promise<number>;
    },
    events: BusEvent.Sink = { publish: () => undefined },
  ): WorkerSupervisor {
    const supervisor = Object.create(WorkerSupervisor.prototype) as WorkerSupervisor;
    Reflect.set(supervisor, "id", 0);
    Reflect.set(supervisor, "proc", proc);
    Reflect.set(supervisor, "running", true);
    Reflect.set(supervisor, "events", events);
    Reflect.set(supervisor, "client", {
      connected: true,
      call: mock(async () => ({})),
      close: mock(() => undefined),
    } satisfies IpcClient);
    return supervisor;
  }

  test("escalates from SIGTERM to SIGKILL when the worker ignores graceful shutdown", async () => {
    process.env.OPENOMNI_WORKER_STOP_GRACE_MS = "1";

    const warnings: Array<{ msg: string; context?: Record<string, unknown> }> = [];
    const collector: BusEvent.Sink = {
      publish(event, data) {
        if (event.name === Operational.Warn.name) {
          warnings.push(data as { msg: string; context?: Record<string, unknown> });
        }
      },
    };
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const signals: NodeJS.Signals[] = [];
    const proc = {
      exited,
      kill: mock((signal: NodeJS.Signals) => {
        signals.push(signal);
        if (signal === "SIGKILL") resolveExit(137);
      }),
    };

    await createStopSupervisor(proc, collector).stop();
    await Promise.resolve();

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        msg: "worker did not stop within grace period; sending SIGKILL",
        context: { workerId: 0, graceMs: 1 },
      }),
    );
  });

  test("does not send SIGKILL when the worker exits during the graceful window", async () => {
    process.env.OPENOMNI_WORKER_STOP_GRACE_MS = "50";

    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const signals: NodeJS.Signals[] = [];
    const proc = {
      exited,
      kill: mock((signal: NodeJS.Signals) => {
        signals.push(signal);
        if (signal === "SIGTERM") resolveExit(0);
      }),
    };

    await createStopSupervisor(proc).stop();

    expect(signals).toEqual(["SIGTERM"]);
  });

  test("treats an empty grace env var as unset instead of immediate escalation", async () => {
    process.env.OPENOMNI_WORKER_STOP_GRACE_MS = "";

    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const signals: NodeJS.Signals[] = [];
    const proc = {
      exited,
      kill: mock((signal: NodeJS.Signals) => {
        signals.push(signal);
        if (signal === "SIGTERM") {
          setTimeout(() => resolveExit(0), 1);
        }
      }),
    };

    await createStopSupervisor(proc).stop();

    expect(signals).toEqual(["SIGTERM"]);
  });
});
