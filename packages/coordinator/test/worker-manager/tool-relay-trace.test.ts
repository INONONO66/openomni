import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createWorkerManager,
  type ToolCallContext,
  type ToolCallParams,
  type WorkerManager,
} from "../../src/worker-manager";
import { collectorPorts } from "../harness/ports";

const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));
const TEST_IDENTITY = {
  runtimeId: "runtime-tool-relay-trace",
  principalId: "principal-tool-relay-trace",
  bootstrap: { configEpoch: "test" },
} as const;

function fixturePrompt(fixture: Record<string, unknown> = {}): string {
  return JSON.stringify({ fixture, prompt: "test" });
}

let manager: WorkerManager | undefined;

afterEach(async () => {
  await manager?.shutdown();
  manager = undefined;
});

describe("worker tool relay trace context", () => {
  test("uses delivered run identity instead of spoofable tool input", async () => {
    let relayedParams: ToolCallParams | undefined;
    let relayedContext: ToolCallContext | undefined;
    manager = createWorkerManager(
      {
        ...TEST_IDENTITY,
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir(),
        maxActiveWorkers: 1,
        idleShutdownMs: 1_000,
      },
      {
        ...collectorPorts(),
        async toolRelay(params, context) {
          relayedParams = params;
          relayedContext = context;
          return {
            id: params.callId,
            toolCallId: params.callId,
            output: "relayed",
            isError: false,
          };
        },
      },
    );

    const result = await manager.deliver("trusted-run", {
      sessionId: "trusted-session",
      traceId: "trusted-trace",
      prompt: fixturePrompt({
        toolRelay: {},
        traceSpoof: {
          traceId: "spoofed-trace",
          sessionId: "spoofed-session",
          runId: "spoofed-run",
        },
      }),
    });

    expect(result).toMatchObject({ status: "succeeded" });

    expect(relayedParams).toMatchObject({
      runId: "trusted-run",
      sessionId: "trusted-session",
      input: {
        traceId: "spoofed-trace",
        sessionId: "spoofed-session",
        runId: "spoofed-run",
      },
    });
    expect(relayedContext).toMatchObject({
      traceContext: {
        traceId: "trusted-trace",
        sessionId: "trusted-session",
        runId: "trusted-run",
      },
    });
    expect(relayedContext?.signal).toBeInstanceOf(AbortSignal);
  });

  test("does not attach another worker slot's active run context", async () => {
    let relayedContext: ToolCallContext | undefined;
    manager = createWorkerManager(
      {
        ...TEST_IDENTITY,
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir(),
        maxActiveWorkers: 2,
        idleShutdownMs: 1_000,
      },
      {
        ...collectorPorts(),
        async toolRelay(params, context) {
          relayedContext = context;
          return {
            id: params.callId,
            toolCallId: params.callId,
            output: "relayed",
            isError: false,
          };
        },
      },
    );

    await Promise.all([
      manager.deliver("target-run", {
        sessionId: "target-session",
        traceId: "target-trace",
        prompt: fixturePrompt({ delayMs: 250 }),
      }),
      manager.deliver("attacker-run", {
        sessionId: "attacker-session",
        traceId: "attacker-trace",
        prompt: fixturePrompt({
          toolRelay: { runId: "target-run" },
          traceSpoof: {
            traceId: "spoofed-trace",
            sessionId: "spoofed-session",
            runId: "spoofed-run",
          },
        }),
      }),
    ]);

    expect(relayedContext).toBeUndefined();
  });
});

function makeSocketDir(): string {
  const socketDir = `/tmp/omo-wm-tool-trace-${process.pid}-${Date.now()}`;
  fs.mkdirSync(socketDir, { recursive: true });
  return socketDir;
}
