import { beforeAll, describe, expect, it } from "bun:test";
import type { Subagent } from "@openomni/protocol";

let BackgroundOutputTool: typeof import("../../../src/runtime/tools/background-output").BackgroundOutputTool;

beforeAll(async () => {
  ({ BackgroundOutputTool } = await import("../../../src/runtime/tools/background-output"));
});

function createMockManager(): {
  getTask: (taskId: string) => Subagent.BackgroundTask | undefined;
  getResult: (taskId: string) => Subagent.BackgroundTaskResult | undefined;
  cancel: (taskId: string) => Promise<boolean>;
  launch: (input: unknown) => Promise<Subagent.BackgroundTask>;
  listByParent: (parentSessionId: string) => Subagent.BackgroundTask[];
  cleanup: () => void;
} {
  const tasks = new Map<string, Subagent.BackgroundTask>();
  const results = new Map<string, Subagent.BackgroundTaskResult>();

  return {
    getTask: (taskId) => tasks.get(taskId),
    getResult: (taskId) => results.get(taskId),
    cancel: async (taskId) => {
      const task = tasks.get(taskId);
      if (!task) return false;
      tasks.set(taskId, { ...task, status: "cancelled" });
      return true;
    },
    launch: async (_input) => {
      const task: Subagent.BackgroundTask = {
        id: "bg_test123",
        agentName: "test-agent",
        prompt: "test prompt",
        status: "running",
        parentSessionId: "parent-123",
        queuedAt: Date.now(),
        depth: 0,
      };
      tasks.set(task.id, task);
      return task;
    },
    listByParent: (parentSessionId) =>
      [...tasks.values()].filter((t) => t.parentSessionId === parentSessionId),
    cleanup: () => {
      tasks.clear();
      results.clear();
    },
  };
}

describe("BackgroundOutputTool", () => {
  it("creates tool with correct spec name", () => {
    const { spec } = BackgroundOutputTool.create();
    expect(spec.name).toBe("background_output");
  });

  it("spec has required input properties", () => {
    const { spec } = BackgroundOutputTool.create();
    expect(spec.inputSchema.properties).toHaveProperty("taskId");
    expect(spec.inputSchema.properties).toHaveProperty("block");
    expect(spec.inputSchema.properties).toHaveProperty("timeout");
  });

  it("returns error when task not found", async () => {
    const manager = createMockManager();
    const { execute } = BackgroundOutputTool.create({ backgroundManager: manager });
    const result = await execute({ taskId: "nonexistent", block: false });
    expect(result.isError).toBe(true);
  });

  it("returns current status when task is running and block is false", async () => {
    const manager = createMockManager();
    const task = await manager.launch({});
    const { execute } = BackgroundOutputTool.create({ backgroundManager: manager });
    const result = await execute({ taskId: task.id, block: false });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("running");
  });

  it("returns result output when task is completed", async () => {
    const manager = createMockManager();
    const task = await manager.launch({});
    const _result: Subagent.BackgroundTaskResult = {
      taskId: task.id,
      status: "completed",
      output: "task output",
    };
    const { execute } = BackgroundOutputTool.create({ backgroundManager: manager });
    const toolResult = await execute({ taskId: task.id, block: false });
    expect(toolResult.isError).toBe(false);
  });

  it("waits for result when block is true", async () => {
    const manager = createMockManager();
    const task = await manager.launch({});
    const { execute } = BackgroundOutputTool.create({ backgroundManager: manager });
    const result = await execute({ taskId: task.id, block: true, timeout: 100 });
    expect(result).toHaveProperty("output");
  });
});
