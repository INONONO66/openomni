import { beforeAll, describe, expect, it, mock } from "bun:test";
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

describe("SubagentTool", () => {
  it("returns error when agent not registered", async () => {
    resetState();
    const { execute } = SubagentTool.create();
    const result = await execute({ agentName: "unknown", prompt: "hi" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not registered");
  });

  it("denies circular delegation", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("agent-a"));
    const visited = new Set(["agent-a"]);
    const parentAbort = {} as AbortSignal;
    const { execute } = SubagentTool.create({
      delegationContext: {
        depth: 1,
        maxDepth: 3,
        visitedAgents: visited,
        parentAbort,
      },
    });

    const result = await execute({ agentName: "agent-a", prompt: "hi" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("circular");
  });

  it("denies when depth limit exceeded", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("agent-b"));
    const parentAbort = {} as AbortSignal;
    const { execute } = SubagentTool.create({
      delegationContext: {
        depth: 3,
        maxDepth: 3,
        visitedAgents: new Set(),
        parentAbort,
      },
    });

    const result = await execute({ agentName: "agent-b", prompt: "hi" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("depth");
  });

  it("passes definition budget directly to child agent", async () => {
    resetState();
    mockChatAgentCreate = mock(() => ({
      run: mock(async () => ({ text: "ok", usage: undefined })),
    }));
    AgentRegistry.define(makeDefinition("budget-agent", { budget: { maxTurns: 10 } }));
    const { execute } = SubagentTool.create();
    await execute({ agentName: "budget-agent", prompt: "hi" });
    expect(mockChatAgentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ budget: { maxTurns: 10 } }),
    );
  });

  it("passes temperature as providerOptions to child agent", async () => {
    resetState();
    mockChatAgentCreate = mock(() => ({
      run: mock(async () => ({ text: "ok", usage: undefined })),
    }));
    AgentRegistry.define(
      makeDefinition("temp-agent", {
        temperature: 0.5,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      }),
    );
    const { execute } = SubagentTool.create();
    await execute({ agentName: "temp-agent", prompt: "hi" });
    expect(mockChatAgentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: expect.objectContaining({ temperature: 0.5 }),
      }),
    );
  });

  it("passes no providerOptions when no variant or temperature", async () => {
    resetState();
    mockChatAgentCreate = mock(() => ({
      run: mock(async () => ({ text: "ok", usage: undefined })),
    }));
    AgentRegistry.define(makeDefinition("plain-agent"));
    const { execute } = SubagentTool.create();
    await execute({ agentName: "plain-agent", prompt: "hi" });
    expect(mockChatAgentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ providerOptions: undefined }),
    );
  });

  it("spec has correct name and inputSchema", () => {
    resetState();
    const { spec } = SubagentTool.create();
    expect(spec.name).toBe("subagent");
    expect(spec.inputSchema).toBeDefined();
    const schema = spec.inputSchema as {
      required: string[];
      properties: { sessionId: { description: string } };
    };
    expect(schema.required).toContain("agentName");
    expect(schema.required).toContain("prompt");
    expect(schema.properties.sessionId.description).toContain(
      "continue an existing subagent session",
    );
  });

  it("uses ChatAgent when subagentRuntime is not provided", async () => {
    resetState();
    mockChatAgentCreate = mock(() => ({
      run: mock(async () => ({ text: "legacy output", usage: undefined })),
    }));

    AgentRegistry.define(makeDefinition("legacy-agent"));
    const { execute } = SubagentTool.create();

    const result = await execute({ agentName: "legacy-agent", prompt: "hello" });

    expect(mockChatAgentCreate).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
    expect(result.output).toBe("legacy output");
  });

  it("spawns a new runtime session when sessionId is absent", async () => {
    resetState();
    const spawn = mock(async () => ({
      sessionId: "session-1",
      runId: "run-1",
      output: "spawned output",
    }));

    AgentRegistry.define(makeDefinition("runtime-agent"));
    const { execute } = SubagentTool.create({
      subagentRuntime: {
        spawn,
        send: mock(async () => ({
          sessionId: "unused",
          runId: "unused",
          output: "unused",
        })),
      },
    });

    const result = await execute({ agentName: "runtime-agent", prompt: "hello world" });

    expect(mockChatAgentCreate).toHaveBeenCalledTimes(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
    expect(result.output).toBe("spawned output\n[session:session-1]");
  });

  it("continues an existing runtime session when sessionId is provided", async () => {
    resetState();
    const send = mock(async () => ({
      sessionId: "session-2",
      runId: "run-2",
      output: "continued output",
    }));

    AgentRegistry.define(makeDefinition("runtime-agent-2"));
    const { execute } = SubagentTool.create({
      subagentRuntime: {
        spawn: mock(async () => ({
          sessionId: "unused",
          runId: "unused",
          output: "unused",
        })),
        send,
      },
    });

    const result = await execute({
      agentName: "runtime-agent-2",
      prompt: "continue please",
      sessionId: "existing-session",
    });

    expect(mockChatAgentCreate).toHaveBeenCalledTimes(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
    expect(result.output).toBe("continued output\n[session:session-2]");
  });
});
