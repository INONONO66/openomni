import { describe, expect, it } from "bun:test";
import { InstanceRegistry } from "../../../src/runtime/messenger/instance-registry";
import { createAgentRuntimeContext } from "../../../src/core/runtime-context";

function isolatedIt(name: string, fn: () => Promise<void> | void): void {
  it(name, async () => {
    InstanceRegistry.clear();
    try {
      await fn();
    } finally {
      InstanceRegistry.clear();
    }
  });
}

describe("InstanceRegistry", () => {
  isolatedIt("registers and retrieves an instance by id", () => {
    InstanceRegistry.register("inst-1", "agent-a");
    const inst = InstanceRegistry.getById("inst-1");
    expect(inst?.instanceId).toBe("inst-1");
    expect(inst?.agentId).toBe("agent-a");
    expect(inst?.status).toBe("idle");
  });

  isolatedIt("getByAgent returns all instances of that agent", () => {
    InstanceRegistry.register("inst-1", "agent-a");
    InstanceRegistry.register("inst-2", "agent-a");
    InstanceRegistry.register("inst-3", "agent-b");
    const instances = InstanceRegistry.getByAgent("agent-a");
    expect(instances).toHaveLength(2);
  });

  isolatedIt("unregister removes instance", () => {
    InstanceRegistry.register("inst-1", "agent-a");
    InstanceRegistry.unregister("inst-1");
    expect(InstanceRegistry.getById("inst-1")).toBeUndefined();
  });

  isolatedIt("updateStatus changes instance status", () => {
    InstanceRegistry.register("inst-1", "agent-a");
    InstanceRegistry.updateStatus("inst-1", "busy");
    expect(InstanceRegistry.getById("inst-1")?.status).toBe("busy");
  });

  isolatedIt("updateStatus throws for unknown instance", () => {
    expect(() => InstanceRegistry.updateStatus("missing", "busy")).toThrow();
  });

  isolatedIt("stores metadata", () => {
    InstanceRegistry.register("inst-1", "agent-a", { region: "us-east" });
    expect(InstanceRegistry.getById("inst-1")?.metadata?.region).toBe("us-east");
  });

  isolatedIt("register returns a disposer that unregisters the instance", () => {
    const dispose = InstanceRegistry.register("inst-1", "agent-a");
    expect(InstanceRegistry.getById("inst-1")).toBeDefined();
    dispose();
    expect(InstanceRegistry.getById("inst-1")).toBeUndefined();
  });

  isolatedIt("disposer is idempotent — second call does not throw", () => {
    const dispose = InstanceRegistry.register("inst-1", "agent-a");
    dispose();
    expect(() => dispose()).not.toThrow();
  });

  isolatedIt("context-backed store isolates from default namespace", () => {
    const ctx = createAgentRuntimeContext();
    ctx.instances.register("iso-1", "agent-x");

    expect(InstanceRegistry.getById("iso-1")).toBeUndefined();
    expect(ctx.instances.getById("iso-1")?.agentId).toBe("agent-x");
  });
});
