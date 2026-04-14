import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Subagent } from "@openomni/protocol";
import { AgentRegistry } from "../../../src/runtime/registry/registry";
import { Bus } from "@openomni/session";
import { AgentMessenger } from "../../../src/runtime/messenger/messenger";
import type { AgentProfile } from "@openomni/protocol";

let SubagentTool: typeof import("../../../src/runtime/tools/subagent").SubagentTool;
let mockChatAgentCreate: any;

mock.module("../../../src/core/chat-agent", () => ({
  ChatAgent: {
    create: (...args: unknown[]) => mockChatAgentCreate(...args),
  },
}));

beforeAll(async () => {
  mockChatAgentCreate = mock(() => ({
    run: mock(async () => ({ text: "", usage: undefined })),
  }));
  ({ SubagentTool } = await import("../../../src/runtime/tools/subagent"));
});

function createMockBackgroundManager(): {
  launch: (input: unknown) => Promise<Subagent.BackgroundTask>;
  getTask: (taskId: string) => Subagent.BackgroundTask | undefined;
  getResult: (taskId: string) => Subagent.BackgroundTaskResult | undefined;
  cancel: (taskId: string) => Promise<boolean>;
  listByParent: (parentSessionId: string) => Subagent.BackgroundTask[];
  cleanup: () => void;
} {
  const tasks = new Map<string, Subagent.BackgroundTask>();

  return {
    launch: async () => {
      const task: Subagent.BackgroundTask = {
        id: "bg_test123",
        agentName: "test",
        prompt: "hello",
        status: "pending",
        parentSessionId: "parent",
        queuedAt: Date.now(),
        depth: 0,
      };
      tasks.set(task.id, task);
      return task;
    },
    getTask: (taskId) => tasks.get(taskId),
    getResult: () => undefined,
    cancel: async () => false,
    listByParent: () => [],
    cleanup: () => {
      tasks.clear();
    },
  };
}

function makeDefinition(
  name: string,
  overrides: Partial<AgentProfile.Definition> = {},
): AgentProfile.Definition {
  return {
    name,
    description: `${name} agent`,
    tools: [],
    ...overrides,
  };
}

function resetState() {
  AgentRegistry.clear();
  Bus.reset();
  AgentMessenger._resetLog();
  mockChatAgentCreate = mock(() => ({
    run: mock(async () => ({ text: "", usage: undefined })),
  }));
}

describe("SubagentTool background mode", () => {
  it("spec has background property in inputSchema", () => {
    resetState();
    const { spec } = SubagentTool.create();
    expect(spec.inputSchema.properties).toHaveProperty("background");
  });

  it("launches background task when background is true with backgroundManager", async () => {
    resetState();
    const manager = createMockBackgroundManager();
    AgentRegistry.define(makeDefinition("test"));
    const { execute } = SubagentTool.create({ backgroundManager: manager });

    const result = await execute({
      agentName: "test",
      prompt: "hello",
      background: true,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("bg_");
  });

  it("returns error when background is true but backgroundManager not provided", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("test"));
    const { execute } = SubagentTool.create();

    const result = await execute({
      agentName: "test",
      prompt: "hello",
      background: true,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("background");
  });

  it("uses sync path when background is false", async () => {
    resetState();
    const { execute } = SubagentTool.create();

    const result = await execute({
      agentName: "unknown",
      prompt: "hello",
      background: false,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("not registered");
  });

  it("uses sync path when background is not specified", async () => {
    resetState();
    const { execute } = SubagentTool.create();

    const result = await execute({
      agentName: "unknown",
      prompt: "hello",
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("not registered");
  });
});
