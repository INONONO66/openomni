import { describe, expect, it } from "bun:test";
import type { AgentProfile, Messenger } from "@openomni/protocol";
import { createAgentRuntimeContext, getDefaultContext } from "../../src/core/runtime-context";
import type { ChatAgentConfig } from "../../src/core/types";

function makeDefinition(name: string): AgentProfile.Definition {
  return {
    name,
    description: `${name} agent`,
    tools: [],
  };
}

function makeEnvelope(id: string): Messenger.MessageEnvelope {
  return {
    id,
    traceId: "trace-1",
    correlationId: null,
    sessionId: "sess-1",
    runId: "run-1",
    fromAgentId: "agent-a",
    toAgentId: "agent-b",
    sentAt: new Date(0).toISOString(),
    schemaRef: "text",
    payload: "hello",
    persistencePolicy: "both",
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

  it("keeps instance registries independent and register returns a disposer", () => {
    const left = createAgentRuntimeContext();
    const right = createAgentRuntimeContext();

    const dispose = left.instances.register("inst-1", "agent-a", { lane: "main" });
    right.instances.register("inst-2", "agent-a");
    left.instances.updateStatus("inst-1", "busy");

    expect(left.instances.getById("inst-1")?.status).toBe("busy");
    expect(left.instances.getById("inst-1")?.metadata?.lane).toBe("main");
    expect(left.instances.getByAgent("agent-a")).toHaveLength(1);
    expect(right.instances.getById("inst-1")).toBeUndefined();
    expect(right.instances.getByAgent("agent-a")).toHaveLength(1);
    expect(() => left.instances.updateStatus("missing", "error")).toThrow(
      "Instance 'missing' not registered",
    );

    dispose();

    expect(left.instances.getById("inst-1")).toBeUndefined();
    expect(right.instances.getById("inst-2")?.status).toBe("idle");
  });

  it("keeps message logs independent and returns shallow copies", () => {
    const left = createAgentRuntimeContext();
    const right = createAgentRuntimeContext();

    left.messageLog.append(makeEnvelope("left-1"));
    right.messageLog.append(makeEnvelope("right-1"));
    const copy = left.messageLog.getLog();
    copy.push(makeEnvelope("left-2"));

    expect(left.messageLog.getLog().map((envelope) => envelope.id)).toEqual(["left-1"]);
    expect(right.messageLog.getLog().map((envelope) => envelope.id)).toEqual(["right-1"]);

    left.messageLog.reset();

    expect(left.messageLog.getLog()).toHaveLength(0);
    expect(right.messageLog.getLog()).toHaveLength(1);
  });

  it("prunes the oldest half before appending when the message log reaches the cap", () => {
    const context = createAgentRuntimeContext();

    for (let i = 0; i < 1001; i++) {
      context.messageLog.append(makeEnvelope(`msg-${i}`));
    }

    const log = context.messageLog.getLog();
    expect(log).toHaveLength(501);
    expect(log[0].id).toBe("msg-500");
    expect(log[log.length - 1]?.id).toBe("msg-1000");
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
    first.messageLog.append(makeEnvelope("default-message"));
    first.instances.register("default-instance", "default-agent");

    expect(second).toBe(first);
    expect(second.registry.get("default-agent")?.name).toBe("default-agent");
    expect(second.messageLog.getLog().map((envelope) => envelope.id)).toContain("default-message");
    expect(second.instances.getById("default-instance")?.agentId).toBe("default-agent");
  });
});
