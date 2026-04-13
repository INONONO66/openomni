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
      variant: "high",
      temperature: 0.7,
      budget: { maxTurns: 10 },
    });
    expect(result.model?.provider).toBe("anthropic");
    expect(result.permissions?.allowlist).toEqual(["read_file"]);
    expect(result.variant).toBe("high");
    expect(result.temperature).toBe(0.7);
    expect(result.budget?.maxTurns).toBe(10);
  });

  it("rejects missing required fields", () => {
    expect(() => AgentProfile.Definition.parse({ name: "x" })).toThrow();
  });
});

describe("rejection (schema-enforced)", () => {
  it("rejects temperature < 0", () =>
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        temperature: -0.1,
      }),
    ).toThrow());
  it("rejects temperature > 2", () =>
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        temperature: 2.1,
      }),
    ).toThrow());
});

describe("acceptance (documents current behavior)", () => {
  it("accepts variant string", () =>
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        variant: "high",
      }),
    ).not.toThrow());
  it("accepts temperature = 0", () =>
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        temperature: 0,
      }),
    ).not.toThrow());
  it("accepts temperature = 2", () =>
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        temperature: 2,
      }),
    ).not.toThrow());
  it("accepts budget with maxTurns", () =>
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        budget: { maxTurns: 10 },
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
