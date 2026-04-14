import { beforeAll, describe, expect, it } from "bun:test";
import type { Subagent } from "@openomni/protocol";

let BackgroundCancelTool: typeof import("../../../src/runtime/tools/background-cancel").BackgroundCancelTool;

beforeAll(async () => {
  ({ BackgroundCancelTool } = await import("../../../src/runtime/tools/background-cancel"));
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
        status: "pending",
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

describe("BackgroundCancelTool", () => {
  it("creates tool with correct spec name", () => {
    const { spec } = BackgroundCancelTool.create();
    expect(spec.name).toBe("background_cancel");
  });

  it("spec has required input properties", () => {
    const { spec } = BackgroundCancelTool.create();
    expect(spec.inputSchema.properties).toHaveProperty("taskId");
  });

  it("returns error when task not found", async () => {
    const manager = createMockManager();
    const { execute } = BackgroundCancelTool.create({ backgroundManager: manager });
    const result = await execute({ taskId: "nonexistent" });
    expect(result.isError).toBe(true);
  });

  it("returns success when task is cancelled", async () => {
    const manager = createMockManager();
    const task = await manager.launch({});
    const { execute } = BackgroundCancelTool.create({ backgroundManager: manager });
    const result = await execute({ taskId: task.id });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("cancelled");
  });

  it("returns error when cancel fails", async () => {
    const manager = createMockManager();
    const { execute } = BackgroundCancelTool.create({ backgroundManager: manager });
    const result = await execute({ taskId: "bg_nonexistent" });
    expect(result.isError).toBe(true);
  });
});
