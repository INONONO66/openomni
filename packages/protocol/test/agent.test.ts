import { describe, expect, test } from "bun:test";
import { AgentProfile } from "../src/agent/index";

const it = test;

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

describe("rejection (schema-enforced)", () => {
  it("rejects maxTurns = 0", () =>
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        maxTurns: 0,
      }),
    ).toThrow());
  it("rejects maxTurns = -1", () =>
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        maxTurns: -1,
      }),
    ).toThrow());
  it("rejects maxTurns = 1.5", () =>
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        maxTurns: 1.5,
      }),
    ).toThrow());
});

describe("acceptance (documents current behavior)", () => {
  it("accepts maxTurns = 1", () =>
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        maxTurns: 1,
      }),
    ).not.toThrow());
  it("accepts empty name string", () =>
    expect(() => AgentProfile.Definition.parse({ name: "", description: "x" })).not.toThrow());
  it("accepts permissions: {}", () =>
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        permissions: {},
      }),
    ).not.toThrow());
});
