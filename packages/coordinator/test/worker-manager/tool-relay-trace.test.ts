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
      prompt: "test",
      relayTool: true,
    });

    expect(relayedParams).toMatchObject({
      runId: "trusted-run",
      sessionId: "spoofed-session",
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
    expect(result).toMatchObject({ toolRelayResult: { output: "relayed", isError: false } });
  });

  test("does not attach another worker slot's active run context", async () => {
    let relayedContext: ToolCallContext | undefined;
    manager = createWorkerManager(
      {
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
        prompt: "test",
        delayMs: 250,
      }),
      manager.deliver("attacker-run", {
        sessionId: "attacker-session",
        traceId: "attacker-trace",
        prompt: "test",
        relayTool: true,
        relayRunId: "target-run",
      }),
    ]);

    expect(relayedContext?.signal).toBeInstanceOf(AbortSignal);
    expect(relayedContext?.traceContext).toBeUndefined();
  });
});

function makeSocketDir(): string {
  const socketDir = `/tmp/omo-wm-tool-trace-${process.pid}-${Date.now()}`;
  fs.mkdirSync(socketDir, { recursive: true });
  return socketDir;
}
