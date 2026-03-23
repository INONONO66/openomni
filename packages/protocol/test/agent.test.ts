import { describe, expect, it } from "bun:test";
import { AgentProfile } from "../src/agent/index";

describe("AgentProfile.Definition", () => {
  it("parses minimal definition", () => {
    const result = AgentProfile.Definition.parse({
      name: "explore",
      description: "Explores the codebase",
    });
    expect(result.name).toBe("explore");
    expect(result.tools).toEqual([]);
  });

  it("parses full definition", () => {
    const result = AgentProfile.Definition.parse({
      name: "coder",
      description: "Writes code",
      systemPrompt: "You are a coder.",
      tools: ["read_file", "write_file"],
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      permissions: { allowlist: ["read_file"] },
      maxTurns: 10,
    });
    expect(result.model?.provider).toBe("anthropic");
    expect(result.permissions?.allowlist).toEqual(["read_file"]);
    expect(result.maxTurns).toBe(10);
  });

  it("rejects missing required fields", () => {
    expect(() => AgentProfile.Definition.parse({ name: "x" })).toThrow();
  });
});
