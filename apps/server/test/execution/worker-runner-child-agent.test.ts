import { describe, expect, it } from "bun:test";
import type { ChatAgentConfig } from "@openomni/agent";

import { WorkerRunner } from "../../src/execution/worker-runner";
import { createSpawnOptions, createValidRequest, successfulResult } from "./worker-runner-fixture";

describe("WorkerRunner", () => {
  it("exposes requested child_agent tool for worker-local parallelism", async () => {
    const responses: unknown[] = [];
    const agentConfigs: ChatAgentConfig[] = [];
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          workspaceRoot: "/worker/repo",
          tools: [{ name: "child_agent", inputSchema: {} }],
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify() {
              return undefined;
            },
          },
          createAgent: (options) => ({
            async run() {
              agentConfigs.push(options);
              const toolNames = options.tools?.map((tool) => tool.name) ?? [];
              const childAgentTool = options.tools?.find((tool) => tool.name === "child_agent");
              if (!childAgentTool) return successfulResult;
              const variants = childAgentTool.inputSchema.oneOf;
              if (!Array.isArray(variants)) throw new Error("child_agent schema missing variants");

              expect(toolNames).toContain("child_agent");
              expect(variants).toContainEqual(
                expect.objectContaining({
                  properties: expect.objectContaining({ action: { const: "spawn" } }),
                  required: ["action", "prompt"],
                }),
              );
              expect(options.systemPrompt).toContain("child_agent");
              if (!options.toolExecutor) throw new Error("tool executor missing");
              const spawn = await options.toolExecutor({
                id: "child-agent-spawn",
                tool: "child_agent",
                input: { action: "spawn", prompt: "try to escalate", tools: { all: true } },
              });
              const childId = JSON.parse(spawn.output).childId;
              await options.toolExecutor({
                id: "child-agent-await",
                tool: "child_agent",
                input: { action: "await", ids: [childId] },
              });
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses[0]).toMatchObject({ status: "succeeded" });
    expect(agentConfigs).toHaveLength(2);
    expect(agentConfigs[1]?.tools).toEqual([]);
  });

  it("assembles middleware once; child references the parent subset without the drain policy", async () => {
    // #522 defect 2 scope: the injection-queue drain policy drains shared
    // host state and persists into the parent session, so it stays
    // parent-only; every child registration must be one of the parent's.
    const responses: unknown[] = [];
    const agentConfigs: ChatAgentConfig[] = [];
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          tools: [{ name: "child_agent", inputSchema: {} }],
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify() {
              return undefined;
            },
          },
          createAgent: (options) => ({
            async run() {
              agentConfigs.push(options);
              const childAgentTool = options.tools?.find((tool) => tool.name === "child_agent");
              if (!childAgentTool) return successfulResult;
              if (!options.toolExecutor) throw new Error("tool executor missing");
              const spawn = await options.toolExecutor({
                id: "child-mw-spawn",
                tool: "child_agent",
                input: { action: "spawn", prompt: "inspect middleware" },
              });
              const childId = JSON.parse(spawn.output).childId;
              await options.toolExecutor({
                id: "child-mw-await",
                tool: "child_agent",
                input: { action: "await", ids: [childId] },
              });
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses[0]).toMatchObject({ status: "succeeded" });
    expect(agentConfigs).toHaveLength(2);
    const parentMiddleware = agentConfigs[0]?.middleware ?? [];
    const childMiddleware = agentConfigs[1]?.middleware ?? [];
    expect(parentMiddleware.map((reg) => reg.name)).toContain("builtin:injection-queue-drain");
    expect(childMiddleware.map((reg) => reg.name)).not.toContain("builtin:injection-queue-drain");
    for (const registration of childMiddleware) {
      expect(parentMiddleware).toContain(registration);
    }
  });

  it("cancels unawaited child agents when the worker run finishes", async () => {
    const responses: unknown[] = [];
    let childSignal: AbortSignal | undefined;
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          tools: [{ name: "child_agent", inputSchema: {} }],
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify() {
              return undefined;
            },
          },
          createAgent: (options) => ({
            async run() {
              const childAgentTool = options.tools?.find((tool) => tool.name === "child_agent");
              if (!childAgentTool) {
                childSignal = options.signal;
                await new Promise<never>(() => undefined);
              }
              if (!options.toolExecutor) throw new Error("tool executor missing");
              await options.toolExecutor({
                id: "child-agent-spawn",
                tool: "child_agent",
                input: { action: "spawn", prompt: "keep running" },
              });
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses[0]).toMatchObject({ status: "succeeded" });
    expect(childSignal?.aborted).toBe(true);
  });
});
