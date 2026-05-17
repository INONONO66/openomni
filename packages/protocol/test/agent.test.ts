import { describe, expect, test } from "bun:test";
import { AgentProfile, Model } from "../src/index";

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
      permissions: { action: "tool.call", allowlist: ["read_file"] },
      variant: "high",
      temperature: 0.7,
      budget: { maxTurns: 10, warningThreshold: 0.75, reassuranceThreshold: 0.5 },
    });
    expect(result.model?.provider).toBe("anthropic");
    expect(result.model?.id).toBe("claude-3-haiku-20240307");
    expect(result.permissions?.action).toBe("tool.call");
    expect(result.permissions?.allowlist).toEqual(["read_file"]);
    expect(result.variant).toBe("high");
    expect(result.temperature).toBe(0.7);
    expect(result.budget?.maxTurns).toBe(10);
    expect(result.budget?.warningThreshold).toBe(0.75);
    expect(result.budget?.reassuranceThreshold).toBe(0.5);
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

  it("rejects budget thresholds outside (0, 1)", () =>
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        budget: { warningThreshold: 1.1 },
      }),
    ).toThrow());

  it("rejects threshold endpoints", () => {
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        budget: { warningThreshold: 0 },
      }),
    ).toThrow();

    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        budget: { reassuranceThreshold: 1 },
      }),
    ).toThrow();
  });

  it("rejects budget thresholds that invert the staged status order", () => {
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        budget: { warningThreshold: 0.4, reassuranceThreshold: 0.8 },
      }),
    ).toThrow();

    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        budget: { warningThreshold: 0.6, reassuranceThreshold: 0.6 },
      }),
    ).toThrow();

    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        budget: { warningThreshold: 0.5 },
      }),
    ).toThrow();

    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        budget: { reassuranceThreshold: 0.9 },
      }),
    ).toThrow();
  });
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
  it("exposes shared budget threshold defaults", () => {
    expect(AgentProfile.DEFAULT_REASSURANCE_THRESHOLD).toBe(0.6);
    expect(AgentProfile.DEFAULT_WARNING_THRESHOLD).toBe(0.8);
  });
  it("exposes budget threshold input as a Zod-first contract", () =>
    expect(AgentProfile.BudgetThresholdInput.parse({ warningThreshold: 0.9 })).toEqual({
      warningThreshold: 0.9,
    }));
  it("accepts a standalone model ref", () =>
    expect(Model.Ref.parse({ provider: "openai", id: "gpt-4o" })).toEqual({
      provider: "openai",
      id: "gpt-4o",
    }));
  it("keeps AgentProfile.ModelRef as a compatibility alias", () =>
    expect(AgentProfile.ModelRef.parse({ provider: "openai", id: "gpt-4o" })).toEqual({
      provider: "openai",
      id: "gpt-4o",
    }));
  it("accepts empty name string", () =>
    expect(() => AgentProfile.Definition.parse({ name: "", description: "x" })).not.toThrow());
  it("accepts action-only permissions", () =>
    expect(() =>
      AgentProfile.Definition.parse({
        name: "x",
        description: "x",
        permissions: { action: "tool.call" },
      }),
    ).not.toThrow());
});
