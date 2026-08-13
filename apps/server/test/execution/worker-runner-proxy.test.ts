import { describe, expect, it } from "bun:test";
import { WorkspaceLock } from "@openomni/openomni";
import type { Tool, WorkerBootstrap } from "@openomni/protocol";

import { WorkerRunner } from "../../src/execution/worker-runner";
import {
  createSpawnOptions,
  createValidRequest,
  successfulResult,
  toolCallContext,
  type ActiveRun,
} from "./worker-runner-fixture";

describe("WorkerRunner", () => {
  it("returns unknown settlement for proxied tool IPC failures and uses an extended call timeout", async () => {
    const responses: unknown[] = [];
    const workspaceRoot = `/tmp/openomni-worker-runner-test-${crypto.randomUUID()}`;
    const serverCalls: Array<{
      method: string;
      params?: Record<string, unknown>;
      timeoutMs?: number;
    }> = [];
    let proxiedResult: Tool.Result | undefined;
    const bootstrap: WorkerBootstrap.Bootstrap = {
      configEpoch: "epoch-1",
      agents: [],
      toolCatalog: [
        {
          canonicalName: "mcp.server.write_file",
          exposedName: "mcp_server_write_file",
          source: "mcp",
          category: "execution",
          riskTier: 1,
          spec: { name: "mcp.server.write_file", inputSchema: {} },
        },
      ],
    };
    const request = createValidRequest();
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...request,
          tools: [{ name: "mcp.server.write_file", inputSchema: {} }],
          toolConfig: { workspaceRoot },
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call(method, params, timeoutMs) {
              serverCalls.push({ method, params, timeoutMs });
              throw new Error("request timeout: worker.tool_call");
            },
            notify() {
              // lifecycle notification
            },
          },
          getBootstrap: () => bootstrap,
          createAgent: (options) => ({
            async run() {
              if (!options.toolExecutor) throw new Error("tool executor missing");
              proxiedResult = await options.toolExecutor(
                {
                  id: "agent-tool-call",
                  tool: "mcp_server_write_file",
                  input: {},
                },
                toolCallContext(),
              );
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    try {
      await responseReceived;

      expect(proxiedResult).toMatchObject({
        id: expect.any(String),
        toolCallId: expect.any(String),
        output: "request timeout: worker.tool_call",
        isError: true,
        settlement: "unknown",
      });
      expect(serverCalls).toContainEqual(
        expect.objectContaining({
          method: "worker.tool_call",
          timeoutMs: 300_000,
        }),
      );
      expect(responses[0]).toMatchObject({ status: "succeeded" });
    } finally {
      WorkspaceLock.clearUnsafe(workspaceRoot);
    }
  });

  it("aborts a proxied tool IPC wait without waiting for the full IPC timeout", async () => {
    const responses: unknown[] = [];
    const activeRuns = new Map<string, ActiveRun>();
    const serverCalls: Array<{
      method: string;
      params?: Record<string, unknown>;
      timeoutMs?: number;
    }> = [];
    let proxiedResult: Tool.Result | undefined;
    const bootstrap: WorkerBootstrap.Bootstrap = {
      configEpoch: "epoch-1",
      agents: [],
      toolCatalog: [
        {
          canonicalName: "mcp.server.slow_write",
          exposedName: "mcp_server_slow_write",
          source: "mcp",
          category: "execution",
          riskTier: 1,
          spec: { name: "mcp.server.slow_write", inputSchema: {} },
        },
      ],
    };
    const request = createValidRequest();
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...request,
          tools: [{ name: "mcp.server.slow_write", inputSchema: {} }],
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          activeRuns,
          server: {
            call(method, params, timeoutMs) {
              serverCalls.push({ method, params, timeoutMs });
              if (method === "worker.tool_call") {
                activeRuns.get("run-1")?.controller.abort();
                return new Promise<unknown>(() => undefined);
              }
              if (method === "worker.tool_call_cancel") {
                return Promise.resolve({ cancelled: true, settlement: "unknown" });
              }
              throw new Error(`unexpected server call: ${method}`);
            },
            notify() {
              // lifecycle notification
            },
          },
          getBootstrap: () => bootstrap,
          createAgent: (options) => ({
            async run() {
              if (!options.toolExecutor) throw new Error("tool executor missing");
              proxiedResult = await options.toolExecutor(
                {
                  id: "agent-tool-call",
                  tool: "mcp_server_slow_write",
                  input: {},
                },
                { ...toolCallContext(), signal: options.signal },
              );
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(proxiedResult).toMatchObject({
      id: expect.any(String),
      toolCallId: expect.any(String),
      isError: true,
    });
    expect(proxiedResult?.output).toContain("aborted");
    expect(serverCalls).toContainEqual(
      expect.objectContaining({
        method: "worker.tool_call_cancel",
        params: expect.objectContaining({
          runId: "run-1",
          sessionId: "session-1",
          callId: expect.any(String),
        }),
        timeoutMs: 5_000,
      }),
    );
    expect(responses[0]).toMatchObject({ status: "cancelled" });
  });
});
