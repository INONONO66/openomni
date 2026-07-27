import { afterEach, describe, expect, mock, test } from "bun:test";
import { type BusEvent, Ipc, Operational } from "@openomni/protocol";
import type { IpcClient } from "../ipc/client";
import { WorkerSupervisor } from "./supervisor";

const originalStopGraceMs = process.env.OPENOMNI_WORKER_STOP_GRACE_MS;

afterEach(() => {
  if (originalStopGraceMs === undefined) {
    delete process.env.OPENOMNI_WORKER_STOP_GRACE_MS;
  } else {
    process.env.OPENOMNI_WORKER_STOP_GRACE_MS = originalStopGraceMs;
  }
});
const TEST_DIGEST = "a".repeat(64);

function runtimeDefinition() {
  return Ipc.WorkerRuntimeDefinitionV1.parse({
    runtimeId: "runtime-test",
    workerId: "0",
    generation: 0,
    principalId: "principal-test",
    attempt: {
      version: "attempt-ref-v1",
      workItemId: "work-test",
      attemptId: "attempt-test",
      attemptSeq: 1,
    },
    config: {
      configEpoch: "test",
      model: { provider: "anthropic", id: "test" },
      environment: {
        version: "llm-environment-v1",
        catalogSchemaVersion: 1,
        catalogSource: "bundled",
        catalogSourceVersion: "test",
        catalogDigest: TEST_DIGEST,
        modelDigest: TEST_DIGEST,
        endpoint: {
          version: "llm-endpoint-ref-v1",
          kind: "default",
          valueRef: "provider-default",
          endpointDigest: TEST_DIGEST,
        },
        credential: {
          version: "credential-source-ref-v1",
          providerId: "anthropic",
          authType: "api",
          credentialId: "test",
          rotationId: "test",
          sourceKind: "injected_runtime",
          sourcePathDigest: TEST_DIGEST,
          credentialDigest: TEST_DIGEST,
        },
        sdkPackage: "@ai-sdk/anthropic",
        adapterVersion: "test",
        environmentDigest: TEST_DIGEST,
      },
      workspace: {
        canonicalizerVersion: "workspace-v1",
        workspaceId: `w1:${TEST_DIGEST}`,
        canonicalBytesDigest: TEST_DIGEST,
      },
      agents: [],
      toolCatalog: [],
    },
  });
}
function deliveryTask<T extends Record<string, unknown>>(
  value: T,
): T & {
  sessionId: string;
  prompt: string;
} {
  return { sessionId: "session-test", prompt: "test", ...value };
}
function successfulDelivery(params: unknown) {
  const request = Ipc.Methods["coordinator.spawn_run"].params.parse(params);
  return {
    runId: request.runId,
    sessionId: request.sessionId,
    status: "succeeded" as const,
    output: "fixture complete",
    finishReason: "stop",
  };
}

describe("WorkerSupervisor deliver timeout ceiling", () => {
  function createTestSupervisor(mockClient: IpcClient): WorkerSupervisor {
    const supervisor = Object.create(WorkerSupervisor.prototype) as WorkerSupervisor;
    Reflect.set(supervisor, "client", mockClient);
    Reflect.set(supervisor, "bootstrapped", true);
    Reflect.set(supervisor, "authToken", "test-token");
    Reflect.set(supervisor, "runtimeDefinition", async () => runtimeDefinition());
    Reflect.set(supervisor, "runtimeId", "runtime-test");
    Reflect.set(supervisor, "principalId", "principal-test");
    Reflect.set(supervisor, "id", 0);
    Reflect.set(supervisor, "generation", 0);
    Reflect.set(supervisor, "proc", { pid: 1 });
    Reflect.set(supervisor, "activeRuntimeDefinitions", new Map());
    Reflect.set(supervisor, "running", true);
    return supervisor;
  }

  test("deliver timeout is capped at 600_000 ms when budget.maxWallTimeMs is Infinity", async () => {
    let capturedTimeoutMs: number | undefined;
    const mockClient: IpcClient = {
      connected: true,
      call: mock(async (_method: string, params: unknown, timeoutMs: number) => {
        capturedTimeoutMs = timeoutMs;
        return successfulDelivery(params);
      }),
      close: () => undefined,
    };

    const supervisor = createTestSupervisor(mockClient);
    const params = {
      budget: {
        maxWallTimeMs: Infinity,
      },
    };

    await supervisor.deliver("test-run-id", deliveryTask(params));

    expect(capturedTimeoutMs).toBe(600_000);
  });

  test("wall-time ceiling is budget plus margin (no floor — #462 step 5)", async () => {
    let capturedTimeoutMs: number | undefined;
    const mockClient: IpcClient = {
      connected: true,
      call: mock(async (_method: string, params: unknown, timeoutMs: number) => {
        capturedTimeoutMs = timeoutMs;
        return successfulDelivery(params);
      }),
      close: () => undefined,
    };

    const supervisor = createTestSupervisor(mockClient);
    const params = {
      budget: {
        maxWallTimeMs: 100_000,
      },
    };

    await supervisor.deliver("test-run-id", deliveryTask(params));

    // 100_000 + 30_000 margin = 130_000 — the driver kills at budget+margin,
    // it no longer floors small budgets at 300s (#462 §4 wall-time physics).
    expect(capturedTimeoutMs).toBe(130_000);
  });

  test("deliver timeout is capped at 600_000 ms for large budgets", async () => {
    let capturedTimeoutMs: number | undefined;
    const mockClient: IpcClient = {
      connected: true,
      call: mock(async (_method: string, params: unknown, timeoutMs: number) => {
        capturedTimeoutMs = timeoutMs;
        return successfulDelivery(params);
      }),
      close: () => undefined,
    };

    const supervisor = createTestSupervisor(mockClient);
    const params = {
      budget: {
        maxWallTimeMs: 1_000_000,
      },
    };

    await supervisor.deliver("test-run-id", deliveryTask(params));

    // 1_000_000 + 30_000 margin — a finite positive budget is honored above
    // the backstop so the driver never kills a run the loop still allows.
    expect(capturedTimeoutMs).toBe(1_030_000);
  });

  test("unlimited budget (-1 sentinel) gets the 600_000 ms physics backstop", async () => {
    let capturedTimeoutMs: number | undefined;
    const mockClient: IpcClient = {
      connected: true,
      call: mock(async (_method: string, params: unknown, timeoutMs: number) => {
        capturedTimeoutMs = timeoutMs;
        return successfulDelivery(params);
      }),
      close: () => undefined,
    };

    const supervisor = createTestSupervisor(mockClient);
    const params = {
      budget: {
        maxWallTimeMs: -1,
      },
    };

    await supervisor.deliver("test-run-id", deliveryTask(params));

    // -1 means unlimited (AgentBudget): the loop will never stop the run, so
    // the driver backstop must — and must NOT collapse to margin-only ~30s.
    expect(capturedTimeoutMs).toBe(600_000);
  });

  test("missing budget gets the 600_000 ms physics backstop", async () => {
    let capturedTimeoutMs: number | undefined;
    const mockClient: IpcClient = {
      connected: true,
      call: mock(async (_method: string, params: unknown, timeoutMs: number) => {
        capturedTimeoutMs = timeoutMs;
        return successfulDelivery(params);
      }),
      close: () => undefined,
    };

    const supervisor = createTestSupervisor(mockClient);
    const params = {};

    await supervisor.deliver("test-run-id", deliveryTask(params));

    // No budget declared → nothing in the loop bounds the run → the driver
    // backstop is the only wall-time bound.
    expect(capturedTimeoutMs).toBe(600_000);
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
    Reflect.set(supervisor, "bootstrapped", true);
    Reflect.set(
      supervisor,
      "supervisorSocketDir",
      `/tmp/openomni-supervisor-test-${crypto.randomUUID()}`,
    );
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
