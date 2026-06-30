import { beforeAll, describe, expect, it, mock } from "bun:test";
import { AgentRegistry } from "../../../src/runtime/registry/registry";
import { createAgentRuntimeContext } from "../../../src/core/runtime-context";
import type { AgentProfile } from "@openomni/protocol";
import type { DelegationContext } from "../../../src/core/delegation";
import type { SubagentRuntime, SubagentToolOptions } from "../../../src/runtime/tools/subagent";

let SubagentTool: typeof import("../../../src/runtime/tools/subagent").SubagentTool;

beforeAll(async () => {
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

function makeRuntime(): SubagentRuntime {
  return {
    spawn: mock(async () => ({ sessionId: "s", runId: "r", output: "" })),
    send: mock(async () => ({ sessionId: "s", runId: "r", output: "" })),
  };
}

function makeOptions(
  overrides: Omit<Partial<SubagentToolOptions>, "subagentRuntime"> = {},
): SubagentToolOptions {
  return {
    subagentRuntime: makeRuntime(),
    ...overrides,
  };
}

function resetState() {
  AgentRegistry.clear();
}

describe("SubagentTool", () => {
  it("returns error when agent not registered", async () => {
    resetState();
    const { execute } = SubagentTool.create(makeOptions());
    const result = await execute({ agentName: "unknown", prompt: "hi" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not registered");
  });

  it("denies circular delegation", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("agent-a"));
    const visited = new Set(["agent-a"]);
    const parentAbort = undefined as unknown as DelegationContext["parentAbort"];
    const { execute } = SubagentTool.create({
      delegationContext: {
        depth: 1,
        maxDepth: 3,
        visitedAgents: visited,
        parentAbort,
      },
      subagentRuntime: makeRuntime(),
    });

    const result = await execute({ agentName: "agent-a", prompt: "hi" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("circular");
  });

  it("denies when depth limit exceeded", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("agent-b"));
    const parentAbort = undefined as unknown as DelegationContext["parentAbort"];
    const { execute } = SubagentTool.create({
      delegationContext: {
        depth: 3,
        maxDepth: 3,
        visitedAgents: new Set(),
        parentAbort,
      },
      subagentRuntime: makeRuntime(),
    });

    const result = await execute({ agentName: "agent-b", prompt: "hi" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("depth");
  });

  it("spec has correct name and inputSchema", () => {
    resetState();
    const { spec } = SubagentTool.create(makeOptions());
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

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
    expect(result.output).toBe("spawned output");
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

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
    expect(result.output).toBe("continued output");
  });

  it("uses an injected context registry without leaking to default or peer contexts", async () => {
    resetState();
    const contextA = createAgentRuntimeContext();
    const contextB = createAgentRuntimeContext();
    const spawn = mock(async () => ({
      sessionId: "context-session",
      runId: "context-run",
      output: "context output",
    }));

    contextA.registry.define(
      makeDefinition("isolated-agent", { systemPrompt: "context-only prompt" }),
    );

    const { execute } = SubagentTool.create({
      context: contextA,
      subagentRuntime: {
        spawn,
        send: mock(async () => ({
          sessionId: "unused",
          runId: "unused",
          output: "unused",
        })),
      },
    });

    const result = await execute({ agentName: "isolated-agent", prompt: "hello" });

    expect(result.isError).toBe(false);
    expect(AgentRegistry.has("isolated-agent")).toBe(false);
    expect(contextB.registry.has("isolated-agent")).toBe(false);
    const spawnArg = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnArg.systemPrompt).toBe("context-only prompt");
  });

  it("prefers the injected context registry over the default registry", async () => {
    resetState();
    const context = createAgentRuntimeContext();
    const spawn = mock(async () => ({
      sessionId: "context-session",
      runId: "context-run",
      output: "context output",
    }));

    AgentRegistry.define(makeDefinition("shared-agent", { systemPrompt: "default prompt" }));
    context.registry.define(makeDefinition("shared-agent", { systemPrompt: "context prompt" }));

    const { execute } = SubagentTool.create({
      context,
      subagentRuntime: {
        spawn,
        send: mock(async () => ({
          sessionId: "unused",
          runId: "unused",
          output: "unused",
        })),
      },
    });

    const result = await execute({ agentName: "shared-agent", prompt: "hello" });

    expect(result.isError).toBe(false);
    const spawnArg = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnArg.systemPrompt).toBe("context prompt");
  });

  it("uses defaultModel when agent definition has no model", async () => {
    resetState();
    const spawn = mock(async () => ({
      sessionId: "model-session",
      runId: "model-run",
      output: "model output",
    }));

    AgentRegistry.define(makeDefinition("no-model-agent"));
    const customModel = { provider: "openai", id: "gpt-4" };

    const { execute } = SubagentTool.create({
      defaultModel: customModel,
      subagentRuntime: {
        spawn,
        send: mock(async () => ({
          sessionId: "unused",
          runId: "unused",
          output: "unused",
        })),
      },
    });

    const result = await execute({ agentName: "no-model-agent", prompt: "hello" });

    expect(result.isError).toBe(false);
    const spawnArg = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnArg.model).toEqual(customModel);
  });

  it("prefers definition model over defaultModel", async () => {
    resetState();
    const spawn = mock(async () => ({
      sessionId: "model-session",
      runId: "model-run",
      output: "model output",
    }));

    const definitionModel = { provider: "anthropic", id: "claude-3-opus-20240229" };
    AgentRegistry.define(makeDefinition("with-model-agent", { model: definitionModel }));
    const defaultModel = { provider: "openai", id: "gpt-4" };

    const { execute } = SubagentTool.create({
      defaultModel,
      subagentRuntime: {
        spawn,
        send: mock(async () => ({
          sessionId: "unused",
          runId: "unused",
          output: "unused",
        })),
      },
    });

    const result = await execute({ agentName: "with-model-agent", prompt: "hello" });

    expect(result.isError).toBe(false);
    const spawnArg = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnArg.model).toEqual(definitionModel);
  });
});
