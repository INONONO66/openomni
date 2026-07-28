import { describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";

import { WorkerRunner } from "../../src/execution/worker-runner";
import { createSpawnOptions, createValidRequest, successfulResult } from "./worker-runner-fixture";

describe("WorkerRunner", () => {
  it("routes dispatch resident.ask wait requests through worker.inbound_wait IPC", async () => {
    const responses: unknown[] = [];
    const serverCalls: Array<{
      method: string;
      params?: Record<string, unknown>;
      timeoutMs?: number;
    }> = [];
    let inboundResult: Tool.Result | undefined;

    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          workspaceRoot: "/worker/repo",
          tools: [{ name: "dispatch", inputSchema: {} }],
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call(method, params, timeoutMs) {
              serverCalls.push({ method, params, timeoutMs });
              if (method === "worker.inbound_wait") {
                return { requestId: "request-1", accepted: true, output: "approved" };
              }
              throw new Error(`unexpected server call: ${method}`);
            },
            notify() {
              // lifecycle notification
            },
          },
          createAgent: (options) => ({
            async run() {
              if (!options.toolExecutor) throw new Error("tool executor missing");
              inboundResult = await options.toolExecutor({
                id: "agent-inbound-call",
                tool: "dispatch",
                input: {
                  action: "resident.ask",
                  target: { kind: "resident" },
                  payload: "Need approval",
                  wait: true,
                },
              });
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(JSON.parse(inboundResult?.output ?? "{}")).toMatchObject({
      status: "completed",
      output: "approved",
    });
    expect(serverCalls).toContainEqual(
      expect.objectContaining({
        method: "worker.inbound_wait",
        params: expect.objectContaining({
          authToken: "token",
          workerId: "worker-1",
          sessionId: "session-1",
          runId: "run-1",
          callId: expect.any(String),
          payload: "Need approval",
          workspaceRoot: "/worker/repo",
        }),
        timeoutMs: 300_000,
      }),
    );
    expect(responses[0]).toMatchObject({ status: "succeeded" });
  });

  it("keeps worker-runner resident.ask scoped to Resident targets only", async () => {
    const responses: unknown[] = [];
    const serverCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let dispatchResult: Tool.Result | undefined;

    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          tools: [{ name: "dispatch", inputSchema: {} }],
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call(method, params) {
              serverCalls.push({ method, params });
              throw new Error(`unexpected server call: ${method}`);
            },
            notify() {
              // lifecycle notification
            },
          },
          createAgent: (options) => ({
            async run() {
              if (!options.toolExecutor) throw new Error("tool executor missing");
              dispatchResult = await options.toolExecutor({
                id: "agent-dispatch-call",
                tool: "dispatch",
                input: {
                  action: "resident.ask",
                  target: { kind: "worker", sessionId: "owner-hint-worker-session" },
                  payload: "try to route owner directly",
                  wait: true,
                },
              });
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(dispatchResult?.isError).toBe(true);
    expect(JSON.parse(dispatchResult?.output ?? "{}")).toMatchObject({
      status: "failed",
      error: "worker dispatch resident.ask requires resident target",
    });
    expect(serverCalls).toHaveLength(0);
    expect(responses[0]).toMatchObject({ status: "succeeded" });
  });
});
