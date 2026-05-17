import { describe, expect, it } from "bun:test";
import type { AgentProfile } from "@openomni/protocol";
import { createAgentRuntimeContext, getDefaultContext } from "../../src/core/runtime-context";
import type { ChatAgentConfig } from "../../src/core/types";

function makeDefinition(name: string): AgentProfile.Definition {
  return {
    name,
    description: `${name} agent`,
    tools: [],
  };
}

describe("createAgentRuntimeContext", () => {
  it("keeps agent registry stores independent", () => {
    const left = createAgentRuntimeContext();
    const right = createAgentRuntimeContext();

    left.registry.define(makeDefinition("agent-a"));
    right.registry.define(makeDefinition("agent-b"));
    left.registry.override("agent-a", { description: "updated" });

    expect(left.registry.has("agent-a")).toBe(true);
    expect(left.registry.has("agent-b")).toBe(false);
    expect(right.registry.has("agent-a")).toBe(false);
    expect(right.registry.list().map((definition) => definition.name)).toEqual(["agent-b"]);
    expect(left.registry.get("agent-a")?.description).toBe("updated");

    left.registry.replaceAll([makeDefinition("agent-c")]);

    expect(left.registry.list().map((definition) => definition.name)).toEqual(["agent-c"]);
    expect(right.registry.list().map((definition) => definition.name)).toEqual(["agent-b"]);
    expect(() => right.registry.override("missing", {})).toThrow("Agent 'missing' not registered");
  });

  it("can be supplied through ChatAgentConfig without changing runtime behavior", () => {
    const context = createAgentRuntimeContext();
    const config: ChatAgentConfig = {
      model: { provider: "test", id: "model" },
      context,
    };

    expect(config.context).toBe(context);
  });
});

describe("getDefaultContext", () => {
  it("returns the same object and preserves stored data across calls", () => {
    const first = getDefaultContext();
    const second = getDefaultContext();

    first.registry.define(makeDefinition("default-agent"));

    expect(second).toBe(first);
    expect(second.registry.get("default-agent")?.name).toBe("default-agent");
  });
});
