import { describe, it, expect, beforeEach } from "bun:test";
import {
  BuiltinAgentRegistry,
  AgentDefinitionSchema,
  type AgentDefinition,
} from "../../src/agent/registry";

describe("AgentRegistry", () => {
  beforeEach(() => {
    BuiltinAgentRegistry.clear();
    BuiltinAgentRegistry.initializeBuiltins();
  });

  describe("define()", () => {
    it("registers a new agent with valid definition", () => {
      const agent: AgentDefinition = {
        name: "custom",
        description: "A custom agent",
        systemPrompt: "You are a custom agent",
        tools: ["read", "write"],
        permissions: {
          read: true,
          write: true,
          bash: false,
          lsp: false,
          grep: false,
          glob: false,
        },
      };

      const result = BuiltinAgentRegistry.define(agent);
      expect(result.name).toBe("custom");
      expect(result.description).toBe("A custom agent");
    });

    it("throws error when registering duplicate agent", () => {
      const agent: AgentDefinition = {
        name: "duplicate",
        description: "First agent",
        systemPrompt: "System prompt",
        tools: ["read"],
        permissions: {
          read: true,
          write: false,
          bash: false,
          lsp: false,
          grep: false,
          glob: false,
        },
      };

      BuiltinAgentRegistry.define(agent);

      expect(() => {
        BuiltinAgentRegistry.define(agent);
      }).toThrow('Agent "duplicate" is already registered in the registry');
    });

    it("throws ZodError when definition is invalid", () => {
      const invalidAgent = {
        name: "invalid",
        // missing required fields
      } as any;

      expect(() => {
        BuiltinAgentRegistry.define(invalidAgent);
      }).toThrow();
    });

    it("validates permissions object", () => {
      const agent: AgentDefinition = {
        name: "test-perms",
        description: "Test permissions",
        systemPrompt: "System",
        tools: ["read"],
        permissions: {
          read: true,
          write: false,
          bash: true,
          lsp: false,
          grep: true,
          glob: false,
        },
      };

      const result = BuiltinAgentRegistry.define(agent);
      expect(result.permissions.read).toBe(true);
      expect(result.permissions.bash).toBe(true);
      expect(result.permissions.write).toBe(false);
    });

    it("accepts optional model configuration", () => {
      const agent: AgentDefinition = {
        name: "with-model",
        description: "Agent with model",
        systemPrompt: "System",
        tools: ["read"],
        permissions: {
          read: true,
          write: false,
          bash: false,
          lsp: false,
          grep: false,
          glob: false,
        },
        model: {
          providerID: "anthropic",
          modelID: "claude-3-sonnet",
        },
      };

      const result = BuiltinAgentRegistry.define(agent);
      expect(result.model?.providerID).toBe("anthropic");
      expect(result.model?.modelID).toBe("claude-3-sonnet");
    });

    it("accepts optional maxTurns", () => {
      const agent: AgentDefinition = {
        name: "with-turns",
        description: "Agent with max turns",
        systemPrompt: "System",
        tools: ["read"],
        permissions: {
          read: true,
          write: false,
          bash: false,
          lsp: false,
          grep: false,
          glob: false,
        },
        maxTurns: 50,
      };

      const result = BuiltinAgentRegistry.define(agent);
      expect(result.maxTurns).toBe(50);
    });
  });

  describe("get()", () => {
    it("returns agent definition by name", () => {
      const agent = BuiltinAgentRegistry.get("explore");
      expect(agent).toBeDefined();
      expect(agent?.name).toBe("explore");
      expect(agent?.description).toContain("Read-only");
    });

    it("returns undefined for non-existent agent", () => {
      const agent = BuiltinAgentRegistry.get("nonexistent");
      expect(agent).toBeUndefined();
    });

    it("returns correct permissions for explore agent", () => {
      const agent = BuiltinAgentRegistry.get("explore");
      expect(agent?.permissions.read).toBe(true);
      expect(agent?.permissions.write).toBe(false);
      expect(agent?.permissions.bash).toBe(true);
      expect(agent?.permissions.lsp).toBe(false);
    });

    it("returns correct permissions for implement agent", () => {
      const agent = BuiltinAgentRegistry.get("implement");
      expect(agent?.permissions.read).toBe(true);
      expect(agent?.permissions.write).toBe(true);
      expect(agent?.permissions.bash).toBe(true);
      expect(agent?.permissions.lsp).toBe(true);
    });

    it("returns correct permissions for review agent", () => {
      const agent = BuiltinAgentRegistry.get("review");
      expect(agent?.permissions.read).toBe(true);
      expect(agent?.permissions.write).toBe(false);
      expect(agent?.permissions.bash).toBe(false);
      expect(agent?.permissions.lsp).toBe(true);
    });

    it("returns correct permissions for test agent", () => {
      const agent = BuiltinAgentRegistry.get("test");
      expect(agent?.permissions.read).toBe(true);
      expect(agent?.permissions.write).toBe(true);
      expect(agent?.permissions.bash).toBe(true);
      expect(agent?.permissions.lsp).toBe(false);
    });
  });

  describe("list()", () => {
    it("returns all registered agents", () => {
      const agents = BuiltinAgentRegistry.list();
      expect(agents.length).toBe(4);
    });

    it("returns built-in agents after initialization", () => {
      const agents = BuiltinAgentRegistry.list();
      const names = agents.map((a) => a.name);
      expect(names).toContain("explore");
      expect(names).toContain("implement");
      expect(names).toContain("review");
      expect(names).toContain("test");
    });

    it("returns empty array after clear", () => {
      BuiltinAgentRegistry.clear();
      const agents = BuiltinAgentRegistry.list();
      expect(agents.length).toBe(0);
    });

    it("includes newly defined agents", () => {
      const agent: AgentDefinition = {
        name: "custom-agent",
        description: "Custom",
        systemPrompt: "System",
        tools: ["read"],
        permissions: {
          read: true,
          write: false,
          bash: false,
          lsp: false,
          grep: false,
          glob: false,
        },
      };

      BuiltinAgentRegistry.define(agent);
      const agents = BuiltinAgentRegistry.list();
      expect(agents.length).toBe(5);
      expect(agents.some((a) => a.name === "custom-agent")).toBe(true);
    });
  });

  describe("has()", () => {
    it("returns true for registered agent", () => {
      expect(BuiltinAgentRegistry.has("explore")).toBe(true);
      expect(BuiltinAgentRegistry.has("implement")).toBe(true);
    });

    it("returns false for non-existent agent", () => {
      expect(BuiltinAgentRegistry.has("nonexistent")).toBe(false);
    });
  });

  describe("size()", () => {
    it("returns count of registered agents", () => {
      expect(BuiltinAgentRegistry.size()).toBe(4);
    });

    it("updates after defining new agent", () => {
      const agent: AgentDefinition = {
        name: "new-agent",
        description: "New",
        systemPrompt: "System",
        tools: ["read"],
        permissions: {
          read: true,
          write: false,
          bash: false,
          lsp: false,
          grep: false,
          glob: false,
        },
      };

      BuiltinAgentRegistry.define(agent);
      expect(BuiltinAgentRegistry.size()).toBe(5);
    });

    it("returns zero after clear", () => {
      BuiltinAgentRegistry.clear();
      expect(BuiltinAgentRegistry.size()).toBe(0);
    });
  });

  describe("AgentDefinitionSchema", () => {
    it("validates complete agent definition", () => {
      const agent: AgentDefinition = {
        name: "test",
        description: "Test agent",
        systemPrompt: "System prompt",
        tools: ["read", "write"],
        permissions: {
          read: true,
          write: true,
          bash: false,
          lsp: false,
          grep: true,
          glob: false,
        },
        model: {
          providerID: "anthropic",
          modelID: "claude-3",
        },
        maxTurns: 20,
      };

      const result = AgentDefinitionSchema.parse(agent);
      expect(result).toEqual(agent);
    });

    it("rejects missing required fields", () => {
      const incomplete = {
        name: "test",
        // missing description, systemPrompt, tools, permissions
      };

      expect(() => {
        AgentDefinitionSchema.parse(incomplete);
      }).toThrow();
    });

    it("rejects invalid permissions", () => {
      const agent = {
        name: "test",
        description: "Test",
        systemPrompt: "System",
        tools: ["read"],
        permissions: {
          read: "yes", // should be boolean
          write: false,
          bash: false,
          lsp: false,
          grep: false,
          glob: false,
        },
      };

      expect(() => {
        AgentDefinitionSchema.parse(agent);
      }).toThrow();
    });

    it("rejects negative maxTurns", () => {
      const agent: AgentDefinition = {
        name: "test",
        description: "Test",
        systemPrompt: "System",
        tools: ["read"],
        permissions: {
          read: true,
          write: false,
          bash: false,
          lsp: false,
          grep: false,
          glob: false,
        },
        maxTurns: -5,
      };

      expect(() => {
        AgentDefinitionSchema.parse(agent);
      }).toThrow();
    });
  });

  describe("Built-in agents", () => {
    it("explore agent has correct tool set", () => {
      const agent = BuiltinAgentRegistry.get("explore");
      expect(agent?.tools).toContain("read");
      expect(agent?.tools).toContain("grep");
      expect(agent?.tools).toContain("glob");
      expect(agent?.tools).toContain("bash");
    });

    it("implement agent has all tools", () => {
      const agent = BuiltinAgentRegistry.get("implement");
      const expectedTools = [
        "read",
        "write",
        "edit",
        "bash",
        "grep",
        "glob",
        "lsp_goto_definition",
        "lsp_find_references",
        "lsp_symbols",
        "lsp_diagnostics",
        "lsp_prepare_rename",
        "lsp_rename",
        "ast_grep_search",
        "ast_grep_replace",
      ];
      expectedTools.forEach((tool) => {
        expect(agent?.tools).toContain(tool);
      });
    });

    it("review agent has read and LSP tools", () => {
      const agent = BuiltinAgentRegistry.get("review");
      expect(agent?.tools).toContain("read");
      expect(agent?.tools).toContain("lsp_goto_definition");
      expect(agent?.tools).toContain("lsp_find_references");
      expect(agent?.tools).not.toContain("write");
      expect(agent?.tools).not.toContain("bash");
    });

    it("test agent has read, write, and bash", () => {
      const agent = BuiltinAgentRegistry.get("test");
      expect(agent?.tools).toContain("read");
      expect(agent?.tools).toContain("write");
      expect(agent?.tools).toContain("bash");
      expect(agent?.tools).not.toContain("lsp_goto_definition");
    });

    it("all built-in agents have system prompts", () => {
      const agents = BuiltinAgentRegistry.list();
      agents.forEach((agent) => {
        expect(agent.systemPrompt).toBeDefined();
        expect(agent.systemPrompt.length).toBeGreaterThan(0);
      });
    });

    it("all built-in agents have descriptions", () => {
      const agents = BuiltinAgentRegistry.list();
      agents.forEach((agent) => {
        expect(agent.description).toBeDefined();
        expect(agent.description.length).toBeGreaterThan(0);
      });
    });
  });
});
