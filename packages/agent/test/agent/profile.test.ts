import { describe, it, expect, beforeEach } from "bun:test";
import {
  AgentProfileSchema,
  AgentIdentitySchema,
  createAgentIdentity,
  type AgentProfile,
  type AgentIdentity,
} from "../../src/agent/definition/profile";
import { AgentRegistry } from "../../src/agent/registry/profile-store";
import {
  AgentCapabilitiesSchema,
  PolicySpecSchema,
  type AgentCapabilities,
  type PolicySpec,
} from "../../src/agent/definition/capabilities";
import {
  AgentRuntimeSchema,
  createAgentRuntime,
  type AgentRuntime,
} from "../../src/agent/definition/runtime";

describe("AgentProfile", () => {
  describe("AgentProfileSchema", () => {
    it("should validate a complete agent profile", () => {
      const profile: AgentProfile = {
        id: "agent-1",
        name: "Test Agent",
        role: "assistant",
        systemPrompt: "You are a helpful assistant",
        skills: ["reasoning", "coding"],
        tools: ["calculator", "search"],
        policy: {
          tools: ["calculator"],
          dataScopes: [
            {
              type: "files",
              allow: "read",
              roots: ["/data"],
            },
          ],
          capabilities: ["delegate"],
        },
      };

      const result = AgentProfileSchema.parse(profile);
      expect(result.id).toBe("agent-1");
      expect(result.name).toBe("Test Agent");
      expect(result.skills).toEqual(["reasoning", "coding"]);
    });

    it("should validate a minimal agent profile", () => {
      const profile: AgentProfile = {
        id: "agent-minimal",
        name: "Minimal Agent",
      };

      const result = AgentProfileSchema.parse(profile);
      expect(result.id).toBe("agent-minimal");
      expect(result.name).toBe("Minimal Agent");
      expect(result.skills).toBeUndefined();
    });

    it("should reject profile without id", () => {
      const invalid = {
        name: "No ID Agent",
      };

      expect(() => AgentProfileSchema.parse(invalid)).toThrow();
    });

    it("should reject profile without name", () => {
      const invalid = {
        id: "agent-1",
      };

      expect(() => AgentProfileSchema.parse(invalid)).toThrow();
    });
  });

  describe("AgentCapabilitiesSchema", () => {
    it("should validate capabilities with skills and tools", () => {
      const capabilities: AgentCapabilities = {
        skills: ["reasoning", "coding"],
        tools: ["calculator"],
        toolAllowlist: ["calculator", "search"],
        toolDenylist: ["dangerous"],
      };

      const result = AgentCapabilitiesSchema.parse(capabilities);
      expect(result.skills).toEqual(["reasoning", "coding"]);
      expect(result.toolAllowlist).toEqual(["calculator", "search"]);
    });

    it("should validate empty capabilities", () => {
      const capabilities: AgentCapabilities = {};

      const result = AgentCapabilitiesSchema.parse(capabilities);
      expect(result).toEqual({});
    });
  });

  describe("PolicySpecSchema", () => {
    it("should validate policy with file scope", () => {
      const policy: PolicySpec = {
        tools: ["calculator"],
        dataScopes: [
          {
            type: "files",
            allow: "read",
            roots: ["/data"],
          },
        ],
        capabilities: ["delegate"],
      };

      const result = PolicySpecSchema.parse(policy);
      expect(result.tools).toEqual(["calculator"]);
      expect(result.dataScopes?.[0].type).toBe("files");
    });

    it("should validate policy with network scope", () => {
      const policy: PolicySpec = {
        tools: ["http-client"],
        dataScopes: [
          {
            type: "network",
            allow: "egress",
            domains: ["api.example.com"],
          },
        ],
      };

      const result = PolicySpecSchema.parse(policy);
      expect(result.dataScopes?.[0].type).toBe("network");
    });

    it("should validate policy with multiple capabilities", () => {
      const policy: PolicySpec = {
        tools: ["all"],
        capabilities: ["delegate", "escalate"],
      };

      const result = PolicySpecSchema.parse(policy);
      expect(result.capabilities).toEqual(["delegate", "escalate"]);
    });
  });

  describe("AgentIdentitySchema", () => {
    it("should validate agent identity", () => {
      const identity: AgentIdentity = {
        agentId: "agent-1",
        instanceId: "instance-uuid-1",
        version: "1.0.0",
        capabilities: {
          skills: ["reasoning"],
          tools: ["calculator"],
        },
      };

      const result = AgentIdentitySchema.parse(identity);
      expect(result.agentId).toBe("agent-1");
      expect(result.instanceId).toBe("instance-uuid-1");
    });

    it("should validate identity without version", () => {
      const identity: AgentIdentity = {
        agentId: "agent-1",
        instanceId: "instance-uuid-1",
      };

      const result = AgentIdentitySchema.parse(identity);
      expect(result.version).toBeUndefined();
    });
  });

  describe("AgentRuntimeSchema", () => {
    it("should validate complete runtime state", () => {
      const runtime: AgentRuntime = {
        instanceId: "instance-1",
        agentId: "agent-1",
        status: "busy",
        currentTaskId: "task-123",
        lastHeartbeatAt: Date.now(),
        lastError: "Connection timeout",
      };

      const result = AgentRuntimeSchema.parse(runtime);
      expect(result.status).toBe("busy");
      expect(result.currentTaskId).toBe("task-123");
    });

    it("should validate all status values", () => {
      const statuses = ["idle", "busy", "degraded", "offline"] as const;

      for (const status of statuses) {
        const runtime: AgentRuntime = {
          instanceId: "instance-1",
          agentId: "agent-1",
          status,
        };

        const result = AgentRuntimeSchema.parse(runtime);
        expect(result.status).toBe(status);
      }
    });

    it("should reject invalid status", () => {
      const invalid = {
        instanceId: "instance-1",
        agentId: "agent-1",
        status: "invalid",
      };

      expect(() => AgentRuntimeSchema.parse(invalid)).toThrow();
    });
  });
});

describe("AgentRegistry", () => {
  let registry: AgentRegistry;
  let testProfile: AgentProfile;

  beforeEach(() => {
    registry = new AgentRegistry();
    testProfile = {
      id: "test-agent",
      name: "Test Agent",
      role: "assistant",
      skills: ["reasoning"],
      tools: ["calculator"],
    };
  });

  describe("set", () => {
    it("should register a new profile", () => {
      registry.set(testProfile);
      expect(registry.has("test-agent")).toBe(true);
    });

    it("should validate profile on registration", () => {
      const invalid = {
        id: "test-agent",
        // missing name
      };

      expect(() => registry.set(invalid as AgentProfile)).toThrow();
    });

    it("should reject duplicate profile IDs", () => {
      registry.set(testProfile);
      expect(() => registry.set(testProfile)).toThrow();
    });

    it("should store validated profile", () => {
      registry.set(testProfile);
      const retrieved = registry.get("test-agent");
      expect(retrieved?.name).toBe("Test Agent");
    });
  });

  describe("get", () => {
    it("should retrieve registered profile", () => {
      registry.set(testProfile);
      const profile = registry.get("test-agent");
      expect(profile).toBeDefined();
      expect(profile?.id).toBe("test-agent");
    });

    it("should return undefined for non-existent profile", () => {
      const profile = registry.get("non-existent");
      expect(profile).toBeUndefined();
    });
  });

  describe("list", () => {
    it("should return empty array when no profiles", () => {
      const profiles = registry.list();
      expect(profiles).toEqual([]);
    });

    it("should return all registered profiles", () => {
      const profile2: AgentProfile = {
        id: "agent-2",
        name: "Second Agent",
      };

      registry.set(testProfile);
      registry.set(profile2);

      const profiles = registry.list();
      expect(profiles).toHaveLength(2);
      expect(profiles.map((p) => p.id)).toContain("test-agent");
      expect(profiles.map((p) => p.id)).toContain("agent-2");
    });
  });

  describe("remove", () => {
    it("should remove registered profile", () => {
      registry.set(testProfile);
      const removed = registry.remove("test-agent");
      expect(removed).toBe(true);
      expect(registry.has("test-agent")).toBe(false);
    });

    it("should return false when removing non-existent profile", () => {
      const removed = registry.remove("non-existent");
      expect(removed).toBe(false);
    });
  });

  describe("has", () => {
    it("should return true for registered profile", () => {
      registry.set(testProfile);
      expect(registry.has("test-agent")).toBe(true);
    });

    it("should return false for non-existent profile", () => {
      expect(registry.has("non-existent")).toBe(false);
    });
  });

  describe("clear", () => {
    it("should remove all profiles", () => {
      registry.set(testProfile);
      registry.set({
        id: "agent-2",
        name: "Second Agent",
      });

      registry.clear();
      expect(registry.size()).toBe(0);
      expect(registry.list()).toEqual([]);
    });
  });

  describe("size", () => {
    it("should return 0 for empty registry", () => {
      expect(registry.size()).toBe(0);
    });

    it("should return count of registered profiles", () => {
      registry.set(testProfile);
      registry.set({
        id: "agent-2",
        name: "Second Agent",
      });

      expect(registry.size()).toBe(2);
    });

    it("should update size after removal", () => {
      registry.set(testProfile);
      expect(registry.size()).toBe(1);

      registry.remove("test-agent");
      expect(registry.size()).toBe(0);
    });
  });
});

describe("createAgentIdentity", () => {
  it("should create identity from profile", () => {
    const profile: AgentProfile = {
      id: "agent-1",
      name: "Test Agent",
      skills: ["reasoning"],
      tools: ["calculator"],
    };

    const identity = createAgentIdentity(profile);

    expect(identity.agentId).toBe("agent-1");
    expect(identity.instanceId).toBeDefined();
    expect(identity.capabilities?.skills).toEqual(["reasoning"]);
    expect(identity.capabilities?.tools).toEqual(["calculator"]);
  });

  it("should generate unique instance IDs", () => {
    const profile: AgentProfile = {
      id: "agent-1",
      name: "Test Agent",
    };

    const identity1 = createAgentIdentity(profile);
    const identity2 = createAgentIdentity(profile);

    expect(identity1.instanceId).not.toBe(identity2.instanceId);
  });

  it("should include version when provided", () => {
    const profile: AgentProfile = {
      id: "agent-1",
      name: "Test Agent",
    };

    const identity = createAgentIdentity(profile, "2.0.0");

    expect(identity.version).toBe("2.0.0");
  });

  it("should validate generated identity", () => {
    const profile: AgentProfile = {
      id: "agent-1",
      name: "Test Agent",
    };

    const identity = createAgentIdentity(profile);
    const validated = AgentIdentitySchema.parse(identity);

    expect(validated.agentId).toBe("agent-1");
  });
});

describe("createAgentRuntime", () => {
  it("should create runtime from identity", () => {
    const identity: AgentIdentity = {
      agentId: "agent-1",
      instanceId: "instance-1",
    };

    const runtime = createAgentRuntime(identity);

    expect(runtime.agentId).toBe("agent-1");
    expect(runtime.instanceId).toBe("instance-1");
    expect(runtime.status).toBe("idle");
  });

  it("should set initial heartbeat", () => {
    const identity: AgentIdentity = {
      agentId: "agent-1",
      instanceId: "instance-1",
    };

    const before = Date.now();
    const runtime = createAgentRuntime(identity);
    const after = Date.now();

    expect(runtime.lastHeartbeatAt).toBeDefined();
    expect(runtime.lastHeartbeatAt! >= before).toBe(true);
    expect(runtime.lastHeartbeatAt! <= after).toBe(true);
  });

  it("should validate generated runtime", () => {
    const identity: AgentIdentity = {
      agentId: "agent-1",
      instanceId: "instance-1",
    };

    const runtime = createAgentRuntime(identity);
    const validated = AgentRuntimeSchema.parse(runtime);

    expect(validated.status).toBe("idle");
  });
});
