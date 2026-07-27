import { describe, expect, test } from "bun:test";
import type { AgentResult, ChatAgentConfig, ChatAgentInput } from "@openomni/agent";
import type { Model, Tool } from "@openomni/protocol";
import { createChildAgentTool, createChildAgentRuntime } from "../../src/execution-runtime";
import type { NativeTool } from "../../src/execution-runtime";
import { createTestLlmEnvironment } from "../helpers/llm-environment.ts";

const model: Model.Ref = { provider: "test", id: "fixture" };
const { environment, modelCatalog } = createTestLlmEnvironment();

const successfulResult: AgentResult = {
  text: "child done",
  steps: [],
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  finishReason: "stop",
};

function makeCall(input: Record<string, unknown>): Tool.Call {
  return { id: crypto.randomUUID(), tool: "child_agent", input };
}

function makeTool(name: string): NativeTool {
  return {
    spec: { name, inputSchema: { type: "object", properties: {} } },
    riskTier: 0,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    source: "system",
    execute: async (call) => ({
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: `${name}:${call.id}`,
    }),
  };
}

describe("child_agent tool", () => {
  test("spawns and awaits an in-process child agent", async () => {
    const runs: Array<{ config: ChatAgentConfig; input: ChatAgentInput }> = [];
    const runtime = createChildAgentRuntime({
      model,
      environment,
      modelCatalog,
      systemPrompt: "parent system",
      parentMessages: [{ role: "user", content: "parent task" }],
      parentTools: [makeTool("read"), makeTool("dispatch"), makeTool("bash")],
      workspaceRoot: "/repo",
      traceContext: { traceId: "trace-1", sessionId: "session-1", runId: "run-1" },
      createAgent: (config) => ({
        async run(input) {
          runs.push({ config, input });
          return successfulResult;
        },
      }),
    });
    const tool = createChildAgentTool(runtime);

    const spawn = await tool.execute(
      makeCall({
        action: "spawn",
        prompt: "inspect auth flow",
        tools: { categories: ["filesystem"], allow: ["dispatch"] },
      }),
    );
    const spawnOutput = JSON.parse(spawn.output);
    const childId = spawnOutput.childId;

    expect(spawn.isError).toBeUndefined();
    expect(spawnOutput).toMatchObject({ status: "running", childId: expect.any(String) });

    const awaited = await tool.execute(makeCall({ action: "await", ids: [childId] }));
    const awaitedOutput = JSON.parse(awaited.output);

    if (awaited.isError) throw new Error(`await failed: ${awaited.output}`);
    expect(awaitedOutput).toMatchObject({
      children: [
        {
          id: childId,
          status: "completed",
          output: "child done",
          finishReason: "stop",
        },
      ],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.input).toEqual({
      messages: [
        { role: "user", content: "parent task" },
        { role: "user", content: "inspect auth flow" },
      ],
      traceContext: { traceId: "trace-1", sessionId: "session-1", runId: childId },
    });
    expect(runs[0]?.config.tools?.map((entry) => entry.name)).toEqual(["read"]);
  });

  test("returns an error-shaped result when awaiting an unknown child id", async () => {
    const runtime = createChildAgentRuntime({
      model,
      environment,
      modelCatalog,
      parentMessages: [],
      parentTools: [],
      createAgent: () => ({ run: async () => successfulResult }),
    });
    const tool = createChildAgentTool(runtime);

    const result = await tool.execute(makeCall({ action: "await", ids: ["missing-child"] }));

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({
      status: "failed",
      error: "unknown child agent: missing-child",
    });
  });

  test("rejects spawn when the parent run is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;
    const runtime = createChildAgentRuntime({
      model,
      environment,
      modelCatalog,
      parentMessages: [],
      parentTools: [],
      parentSignal: controller.signal,
      createAgent: () => ({
        run: async () => {
          started = true;
          return successfulResult;
        },
      }),
    });
    const tool = createChildAgentTool(runtime);

    const result = await tool.execute(makeCall({ action: "spawn", prompt: "should not start" }));

    expect(started).toBe(false);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({
      status: "failed",
      error: "parent worker run cancelled",
    });
  });

  test("advertises action-specific required fields in the public input schema", () => {
    const runtime = createChildAgentRuntime({
      model,
      environment,
      modelCatalog,
      parentMessages: [],
      parentTools: [],
      createAgent: () => ({ run: async () => successfulResult }),
    });
    const tool = createChildAgentTool(runtime);

    const variants = tool.spec.inputSchema.oneOf;
    if (!Array.isArray(variants)) throw new Error("child_agent schema must define variants");
    expect(variants).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({ action: { const: "spawn" } }),
        required: ["action", "prompt"],
      }),
    );
    expect(variants).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({ action: { const: "cancel" } }),
        required: ["action", "ids"],
      }),
    );
  });

  test("cancels a running child through AbortSignal", async () => {
    let childSignal: AbortSignal | undefined;
    const runtime = createChildAgentRuntime({
      model,
      environment,
      modelCatalog,
      parentMessages: [],
      parentTools: [],
      createAgent: (config) => ({
        run: async () => {
          childSignal = config.signal;
          return await new Promise<AgentResult>(() => undefined);
        },
      }),
    });
    const tool = createChildAgentTool(runtime);

    const spawn = await tool.execute(makeCall({ action: "spawn", prompt: "keep running" }));
    const childId = JSON.parse(spawn.output).childId;
    const cancelled = await tool.execute(makeCall({ action: "cancel", ids: [childId] }));

    expect(cancelled.isError).toBeUndefined();
    expect(childSignal?.aborted).toBe(true);
    expect(JSON.parse(cancelled.output)).toMatchObject({
      children: [{ id: childId, status: "cancelled", prompt: "keep running" }],
    });
  });

  test("enforces a bounded number of running children", async () => {
    const runtime = createChildAgentRuntime({
      model,
      environment,
      modelCatalog,
      parentMessages: [],
      parentTools: [],
      maxChildren: 1,
      createAgent: () => ({
        run: async () => {
          return await new Promise<AgentResult>(() => undefined);
        },
      }),
    });
    const tool = createChildAgentTool(runtime);

    const first = await tool.execute(makeCall({ action: "spawn", prompt: "first" }));
    const second = await tool.execute(makeCall({ action: "spawn", prompt: "second" }));

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.output)).toEqual({
      status: "failed",
      error: "child agent limit reached: 1",
    });
  });

  test("bounds await time for running children", async () => {
    const runtime = createChildAgentRuntime({
      model,
      environment,
      modelCatalog,
      parentMessages: [],
      parentTools: [],
      awaitTimeoutMs: 1,
      createAgent: () => ({
        run: async () => {
          return await new Promise<AgentResult>(() => undefined);
        },
      }),
    });
    const tool = createChildAgentTool(runtime);

    const spawn = await tool.execute(makeCall({ action: "spawn", prompt: "slow" }));
    const childId = JSON.parse(spawn.output).childId;
    const awaited = await tool.execute(makeCall({ action: "await", ids: [childId] }));

    expect(awaited.isError).toBe(true);
    expect(JSON.parse(awaited.output)).toEqual({
      status: "failed",
      error: "child agent await timeout after 1ms",
    });
  });

  test("truncates retained child output in snapshots", async () => {
    const runtime = createChildAgentRuntime({
      model,
      environment,
      modelCatalog,
      parentMessages: [],
      parentTools: [],
      maxOutputChars: 5,
      createAgent: () => ({
        run: async () => ({ ...successfulResult, text: "123456789" }),
      }),
    });
    const tool = createChildAgentTool(runtime);

    const spawn = await tool.execute(makeCall({ action: "spawn", prompt: "verbose" }));
    const childId = JSON.parse(spawn.output).childId;
    const awaited = await tool.execute(makeCall({ action: "await", ids: [childId] }));

    expect(awaited.isError).toBeUndefined();
    expect(JSON.parse(awaited.output)).toMatchObject({
      children: [{ id: childId, status: "completed", output: "12345..." }],
    });
  });
});
