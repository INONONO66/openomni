import { afterEach, describe, expect, it } from "bun:test";
import { AgentRegistry } from "../../../src/runtime/registry/registry";
import type { AgentProfile } from "@openomni/protocol";

function makeDefinition(name: string): AgentProfile.Definition {
  return {
    name,
    description: `${name} agent`,
    tools: [],
  };
}

afterEach(() => {
  AgentRegistry.clear();
});

describe("AgentRegistry", () => {
  it("defines and retrieves an agent", () => {
    AgentRegistry.define(makeDefinition("explore"));
    const result = AgentRegistry.get("explore");
    expect(result?.name).toBe("explore");
  });

  it("has() returns true for registered agent", () => {
    AgentRegistry.define(makeDefinition("coder"));
    expect(AgentRegistry.has("coder")).toBe(true);
  });

  it("has() returns false for unregistered agent", () => {
    expect(AgentRegistry.has("unknown")).toBe(false);
  });

  it("get() returns undefined for unregistered agent", () => {
    expect(AgentRegistry.get("unknown")).toBeUndefined();
  });

  it("list() returns all registered agents", () => {
    AgentRegistry.define(makeDefinition("a"));
    AgentRegistry.define(makeDefinition("b"));
    const names = AgentRegistry.list().map((d) => d.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  it("override() updates existing agent fields", () => {
    AgentRegistry.define(makeDefinition("agent-x"));
    AgentRegistry.override("agent-x", { description: "updated" });
    expect(AgentRegistry.get("agent-x")?.description).toBe("updated");
  });

  it("override() throws for unregistered agent", () => {
    expect(() => AgentRegistry.override("missing", {})).toThrow();
  });

  it("clear() removes all agents", () => {
    AgentRegistry.define(makeDefinition("a"));
    AgentRegistry.clear();
    expect(AgentRegistry.list()).toHaveLength(0);
  });

  it("replaceAll() replaces all agents with new definitions", () => {
    AgentRegistry.define(makeDefinition("old-a"));
    AgentRegistry.define(makeDefinition("old-b"));
    const newDefs = [makeDefinition("new-a"), makeDefinition("new-b"), makeDefinition("new-c")];
    AgentRegistry.replaceAll(newDefs);
    const names = AgentRegistry.list().map((d) => d.name);
    expect(names).toHaveLength(3);
    expect(names).toContain("new-a");
    expect(names).toContain("new-b");
    expect(names).toContain("new-c");
    expect(names).not.toContain("old-a");
    expect(names).not.toContain("old-b");
  });

  it("replaceAll() with empty array clears all agents", () => {
    AgentRegistry.define(makeDefinition("a"));
    AgentRegistry.define(makeDefinition("b"));
    AgentRegistry.replaceAll([]);
    expect(AgentRegistry.list()).toHaveLength(0);
  });
});
