import { afterEach, describe, expect, it } from "bun:test";
import { InstanceRegistry } from "../../../src/runtime/messenger/instance-registry";

afterEach(() => {
  InstanceRegistry.clear();
});

describe("InstanceRegistry", () => {
  it("registers and retrieves an instance by id", () => {
    InstanceRegistry.register("inst-1", "agent-a");
    const inst = InstanceRegistry.getById("inst-1");
    expect(inst?.instanceId).toBe("inst-1");
    expect(inst?.agentId).toBe("agent-a");
    expect(inst?.status).toBe("idle");
  });

  it("getByAgent returns all instances of that agent", () => {
    InstanceRegistry.register("inst-1", "agent-a");
    InstanceRegistry.register("inst-2", "agent-a");
    InstanceRegistry.register("inst-3", "agent-b");
    const instances = InstanceRegistry.getByAgent("agent-a");
    expect(instances).toHaveLength(2);
  });

  it("unregister removes instance", () => {
    InstanceRegistry.register("inst-1", "agent-a");
    InstanceRegistry.unregister("inst-1");
    expect(InstanceRegistry.getById("inst-1")).toBeUndefined();
  });

  it("updateStatus changes instance status", () => {
    InstanceRegistry.register("inst-1", "agent-a");
    InstanceRegistry.updateStatus("inst-1", "busy");
    expect(InstanceRegistry.getById("inst-1")?.status).toBe("busy");
  });

  it("updateStatus throws for unknown instance", () => {
    expect(() => InstanceRegistry.updateStatus("missing", "busy")).toThrow();
  });

  it("stores metadata", () => {
    InstanceRegistry.register("inst-1", "agent-a", { region: "us-east" });
    expect(InstanceRegistry.getById("inst-1")?.metadata?.region).toBe("us-east");
  });
});
