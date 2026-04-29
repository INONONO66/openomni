import { describe, expect, it } from "bun:test";
import { AgentRegistry } from "../../../src/runtime/registry/registry";
import { getDefaultContext } from "../../../src/core/runtime-context";
import type { AgentProfile } from "@openomni/protocol";

function makeDefinition(name: string): AgentProfile.Definition {
  return {
    name,
    description: `${name} agent`,
    tools: [],
  };
}

function itWithCleanRegistry(name: string, fn: () => void): void {
  it(name, () => {
    AgentRegistry.clear();
    try {
      fn();
    } finally {
      AgentRegistry.clear();
    }
  });
}

describe("AgentRegistry", () => {
  itWithCleanRegistry("defines and retrieves an agent", () => {
    AgentRegistry.define(makeDefinition("explore"));
    const result = AgentRegistry.get("explore");
    expect(result?.name).toBe("explore");
  });

  itWithCleanRegistry("has() returns true for registered agent", () => {
    AgentRegistry.define(makeDefinition("coder"));
    expect(AgentRegistry.has("coder")).toBe(true);
  });

  itWithCleanRegistry("has() returns false for unregistered agent", () => {
    expect(AgentRegistry.has("unknown")).toBe(false);
  });

  itWithCleanRegistry("get() returns undefined for unregistered agent", () => {
    expect(AgentRegistry.get("unknown")).toBeUndefined();
  });

  itWithCleanRegistry("list() returns all registered agents", () => {
    AgentRegistry.define(makeDefinition("a"));
    AgentRegistry.define(makeDefinition("b"));
    const names = AgentRegistry.list().map((d) => d.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  itWithCleanRegistry("override() updates existing agent fields", () => {
    AgentRegistry.define(makeDefinition("agent-x"));
    AgentRegistry.override("agent-x", { description: "updated" });
    expect(AgentRegistry.get("agent-x")?.description).toBe("updated");
  });

  itWithCleanRegistry("override() throws for unregistered agent", () => {
    expect(() => AgentRegistry.override("missing", {})).toThrow();
  });

  itWithCleanRegistry("clear() removes all agents", () => {
    AgentRegistry.define(makeDefinition("a"));
    AgentRegistry.clear();
    expect(AgentRegistry.list()).toHaveLength(0);
  });

  itWithCleanRegistry("replaceAll() replaces all agents with new definitions", () => {
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

  itWithCleanRegistry("replaceAll() with empty array clears all agents", () => {
    AgentRegistry.define(makeDefinition("a"));
    AgentRegistry.define(makeDefinition("b"));
    AgentRegistry.replaceAll([]);
    expect(AgentRegistry.list()).toHaveLength(0);
  });

  itWithCleanRegistry("delegates namespace calls to the default runtime context registry", () => {
    AgentRegistry.define(makeDefinition("namespace-agent"));
    expect(getDefaultContext().registry.has("namespace-agent")).toBe(true);

    getDefaultContext().registry.define(makeDefinition("context-agent"));
    expect(AgentRegistry.get("context-agent")?.name).toBe("context-agent");
  });
});
