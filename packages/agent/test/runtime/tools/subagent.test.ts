import { afterEach, describe, expect, it } from "bun:test";
import { AgentRegistry } from "../../../src/runtime/registry/registry";
import { SubagentTool } from "../../../src/runtime/tools/subagent";
import { Bus } from "@openomni/session";
import { AgentMessenger } from "../../../src/runtime/messenger/messenger";
import type { AgentProfile } from "@openomni/protocol";

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

afterEach(() => {
  AgentRegistry.clear();
  Bus.reset();
  AgentMessenger._resetLog();
});

describe("SubagentTool", () => {
  it("returns error when agent not registered", async () => {
    const { execute } = SubagentTool.create();
    const result = await execute({ agentName: "unknown", prompt: "hi" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not registered");
  });

  it("denies circular delegation", async () => {
    AgentRegistry.define(makeDefinition("agent-a"));
    const visited = new Set(["agent-a"]);
    const { execute } = SubagentTool.create({
      delegationContext: {
        depth: 1,
        maxDepth: 3,
        visitedAgents: visited,
        parentAbort: new AbortController().signal,
        budgetPolicy: "inherit",
      },
    });

    const result = await execute({ agentName: "agent-a", prompt: "hi" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("circular");
  });

  it("denies when depth limit exceeded", async () => {
    AgentRegistry.define(makeDefinition("agent-b"));
    const { execute } = SubagentTool.create({
      delegationContext: {
        depth: 3,
        maxDepth: 3,
        visitedAgents: new Set(),
        parentAbort: new AbortController().signal,
        budgetPolicy: "inherit",
      },
    });

    const result = await execute({ agentName: "agent-b", prompt: "hi" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("depth");
  });

  it("spec has correct name and inputSchema", () => {
    const { spec } = SubagentTool.create();
    expect(spec.name).toBe("subagent");
    expect(spec.inputSchema).toBeDefined();
    const schema = spec.inputSchema as { required: string[] };
    expect(schema.required).toContain("agentName");
    expect(schema.required).toContain("prompt");
  });
});
