import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileAgentRegistryStore } from "../../src/agent/file-registry-storage";
import { AgentRegistry, type AgentProfile } from "../../src/agent/profile";

function makeProfile(id: string, name?: string): AgentProfile {
  return { id, name: name ?? `Agent ${id}` };
}

describe("FileAgentRegistryStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-agent-registry-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("set and get profile", () => {
    const store = new FileAgentRegistryStore(dir);
    const profile = makeProfile("a1", "Alpha");

    store.set("a1", profile);

    expect(store.get("a1")).toEqual(profile);
  });

  test("list returns all profiles", () => {
    const store = new FileAgentRegistryStore(dir);

    store.set("a1", makeProfile("a1"));
    store.set("a2", makeProfile("a2"));

    const profiles = store.list();
    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.id).sort()).toEqual(["a1", "a2"]);
  });

  test("remove deletes profile and file", () => {
    const store = new FileAgentRegistryStore(dir);
    store.set("a1", makeProfile("a1"));

    expect(store.remove("a1")).toBe(true);
    expect(store.get("a1")).toBeUndefined();
    expect(store.has("a1")).toBe(false);
    expect(existsSync(join(dir, "a1.json"))).toBe(false);
  });

  test("remove returns false for non-existent", () => {
    const store = new FileAgentRegistryStore(dir);
    expect(store.remove("nope")).toBe(false);
  });

  test("has returns correct values", () => {
    const store = new FileAgentRegistryStore(dir);
    store.set("a1", makeProfile("a1"));

    expect(store.has("a1")).toBe(true);
    expect(store.has("nope")).toBe(false);
  });

  test("size returns profile count", () => {
    const store = new FileAgentRegistryStore(dir);

    expect(store.size()).toBe(0);
    store.set("a1", makeProfile("a1"));
    expect(store.size()).toBe(1);
    store.set("a2", makeProfile("a2"));
    expect(store.size()).toBe(2);
  });

  test("clear removes all profiles and files", () => {
    const store = new FileAgentRegistryStore(dir);
    store.set("a1", makeProfile("a1"));
    store.set("a2", makeProfile("a2"));

    store.clear();

    expect(store.size()).toBe(0);
    expect(store.list()).toEqual([]);
    expect(existsSync(join(dir, "a1.json"))).toBe(false);
    expect(existsSync(join(dir, "a2.json"))).toBe(false);
  });

  test("persists to disk and recovers on reload", () => {
    const store1 = new FileAgentRegistryStore(dir);
    store1.set("a1", makeProfile("a1", "Alpha"));
    store1.set("a2", makeProfile("a2", "Beta"));

    const store2 = new FileAgentRegistryStore(dir);

    expect(store2.size()).toBe(2);
    expect(store2.get("a1")?.name).toBe("Alpha");
    expect(store2.get("a2")?.name).toBe("Beta");
  });

  test("survives removal then reload", () => {
    const store1 = new FileAgentRegistryStore(dir);
    store1.set("a1", makeProfile("a1"));
    store1.set("a2", makeProfile("a2"));
    store1.remove("a1");

    const store2 = new FileAgentRegistryStore(dir);
    expect(store2.size()).toBe(1);
    expect(store2.has("a1")).toBe(false);
    expect(store2.has("a2")).toBe(true);
  });

  test("handles profiles with special characters in id", () => {
    const store = new FileAgentRegistryStore(dir);
    const profile = makeProfile("ns:agent:v1.0", "Namespaced Agent");

    store.set("ns:agent:v1.0", profile);

    const reloaded = new FileAgentRegistryStore(dir);
    expect(reloaded.get("ns:agent:v1.0")?.name).toBe("Namespaced Agent");
  });

  test("profiles with full schema fields persist correctly", () => {
    const store = new FileAgentRegistryStore(dir);
    const profile: AgentProfile = {
      id: "full",
      name: "Full Agent",
      role: "orchestrator",
      systemPrompt: "You are an orchestrator.",
      skills: ["reasoning", "coding"],
      tools: ["calculator", "search"],
      policy: {
        tools: ["calculator"],
        dataScopes: [{ type: "files", allow: "read", roots: ["/data"] }],
        capabilities: ["delegate"],
      },
    };

    store.set("full", profile);
    const reloaded = new FileAgentRegistryStore(dir);

    expect(reloaded.get("full")).toEqual(profile);
  });
});

describe("AgentRegistry storage adapter integration", () => {
  afterEach(() => {
    AgentRegistry.reset();
  });

  test("default store is undefined (each instance creates its own)", () => {
    expect(AgentRegistry.getStore()).toBeUndefined();
  });

  test("configure() swaps the global store", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-configure-"));
    try {
      const fileStore = new FileAgentRegistryStore(dir);
      AgentRegistry.configure(fileStore);

      expect(AgentRegistry.getStore()).toBe(fileStore);
    } finally {
      AgentRegistry.reset();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("new AgentRegistry() uses configured global store", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-global-"));
    try {
      const fileStore = new FileAgentRegistryStore(dir);
      AgentRegistry.configure(fileStore);

      const registry = new AgentRegistry();
      registry.set(makeProfile("a1"));

      expect(fileStore.get("a1")).toBeDefined();
    } finally {
      AgentRegistry.reset();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AgentRegistry constructor accepts explicit store override", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-override-"));
    try {
      const fileStore = new FileAgentRegistryStore(dir);
      const registry = new AgentRegistry(fileStore);

      registry.set(makeProfile("a1"));
      expect(fileStore.get("a1")).toBeDefined();

      expect(AgentRegistry.getStore()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reset() clears configured store", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-reset-"));
    try {
      AgentRegistry.configure(new FileAgentRegistryStore(dir));
      AgentRegistry.reset();

      expect(AgentRegistry.getStore()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("register → restart adapter → lookup recovers", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-restart-"));
    try {
      const store1 = new FileAgentRegistryStore(dir);
      const registry1 = new AgentRegistry(store1);
      registry1.set(makeProfile("persistent-agent", "Persistent"));

      const store2 = new FileAgentRegistryStore(dir);
      const registry2 = new AgentRegistry(store2);

      expect(registry2.get("persistent-agent")?.name).toBe("Persistent");
      expect(registry2.size()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
