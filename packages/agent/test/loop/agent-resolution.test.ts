import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { BuiltinAgentRegistry } from "../../src/agent/registry/registry";
import { ModelsDev } from "@openomni/llm/src/provider";
import {
  resolveAgentDefinition,
  resolveLLM,
  resolveToolExecutor,
  resolveAgentForWorker,
  fallbackToolExecutor,
} from "../../src/worker/agent-resolution";

const FAKE_ANTHROPIC_PROVIDER: ModelsDev.Provider = {
  id: "anthropic",
  name: "Anthropic",
  api: "https://api.anthropic.com",
  env: ["ANTHROPIC_API_KEY"],
  npm: "@ai-sdk/anthropic",
  models: {
    "claude-sonnet-4-20250514": {
      id: "claude-sonnet-4-20250514",
      name: "Claude Sonnet 4",
      family: "claude",
      cost: { input: 3, output: 15 },
      limit: { context: 200000, output: 8192 },
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
    },
  },
};

function mockModelsDevGet(data?: Record<string, ModelsDev.Provider>) {
  return spyOn(ModelsDev, "get").mockResolvedValue(
    data ?? { anthropic: FAKE_ANTHROPIC_PROVIDER },
  );
}

describe("agent-resolution", () => {
  beforeEach(() => {
    BuiltinAgentRegistry.clear();
    BuiltinAgentRegistry.initializeBuiltins();
  });

  describe("resolveAgentDefinition", () => {
    it("returns definition for existing agent", () => {
      const def = resolveAgentDefinition("explore");
      expect(def).toBeDefined();
      expect(def?.name).toBe("explore");
      expect(def?.tools).toContain("read");
    });

    it("returns undefined for nonexistent agent", () => {
      const def = resolveAgentDefinition("nonexistent-agent");
      expect(def).toBeUndefined();
    });

    it("returns undefined when agentId is undefined", () => {
      const def = resolveAgentDefinition(undefined);
      expect(def).toBeUndefined();
    });

    it("returns undefined when agentId is empty string", () => {
      const def = resolveAgentDefinition("");
      expect(def).toBeUndefined();
    });

    it("returns all built-in agents correctly", () => {
      expect(resolveAgentDefinition("explore")).toBeDefined();
      expect(resolveAgentDefinition("implement")).toBeDefined();
      expect(resolveAgentDefinition("review")).toBeDefined();
      expect(resolveAgentDefinition("test")).toBeDefined();
    });

    it("returns agent with model config when present", () => {
      BuiltinAgentRegistry.define({
        name: "custom-with-model",
        description: "Custom agent with model",
        systemPrompt: "You are custom",
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
          modelID: "claude-sonnet-4-20250514",
        },
      });

      const def = resolveAgentDefinition("custom-with-model");
      expect(def?.model?.providerID).toBe("anthropic");
      expect(def?.model?.modelID).toBe("claude-sonnet-4-20250514");
    });
  });

  describe("resolveToolExecutor", () => {
    it("returns fallbackToolExecutor for empty tools array", () => {
      const executor = resolveToolExecutor([]);
      expect(executor).toBe(fallbackToolExecutor);
    });

    it("fallbackToolExecutor returns error for all calls", async () => {
      const executor = resolveToolExecutor([]);
      const results = await executor.execute([
        { id: "call-1", tool: "read", input: {} },
        { id: "call-2", tool: "write", input: {} },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].isError).toBe(true);
      expect(results[0].output).toContain("not configured");
      expect(results[1].isError).toBe(true);
    });

    it("returns filtering executor for non-empty tools", () => {
      const executor = resolveToolExecutor(["read", "write"]);
      expect(executor).not.toBe(fallbackToolExecutor);
    });

    it("rejects disallowed tools", async () => {
      const executor = resolveToolExecutor(["read", "grep"]);
      const results = await executor.execute([
        { id: "call-1", tool: "write", input: {} },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].isError).toBe(true);
      expect(results[0].output).toContain("not allowed");
      expect(results[0].output).toContain("read, grep");
    });

    it("accepts allowed tools with placeholder response", async () => {
      const executor = resolveToolExecutor(["read", "write"]);
      const results = await executor.execute([
        { id: "call-1", tool: "read", input: {} },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].toolCallId).toBe("call-1");
      expect(results[0].output).toContain("allowed but no executor");
    });

    it("handles mixed allowed and disallowed tools", async () => {
      const executor = resolveToolExecutor(["read", "grep"]);
      const results = await executor.execute([
        { id: "call-1", tool: "read", input: {} },
        { id: "call-2", tool: "write", input: {} },
        { id: "call-3", tool: "grep", input: {} },
      ]);

      expect(results).toHaveLength(3);
      expect(results[0].output).toContain("allowed but no executor");
      expect(results[1].output).toContain("not allowed");
      expect(results[2].output).toContain("allowed but no executor");
    });

    it("generates unique IDs for each result", async () => {
      const executor = resolveToolExecutor(["read"]);
      const results = await executor.execute([
        { id: "call-1", tool: "read", input: {} },
        { id: "call-2", tool: "read", input: {} },
      ]);

      expect(results[0].id).not.toBe(results[1].id);
    });

    it("preserves toolCallId from input", async () => {
      const executor = resolveToolExecutor(["read"]);
      const results = await executor.execute([
        { id: "my-call-id", tool: "read", input: {} },
      ]);

      expect(results[0].toolCallId).toBe("my-call-id");
    });
  });

  describe("resolveLLM", () => {
    it("returns LLM runner for valid model config", async () => {
      const spy = mockModelsDevGet();
      try {
        const llm = await resolveLLM({
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
        });
        expect(llm).toBeDefined();
        expect(typeof llm.run).toBe("function");
      } finally {
        spy.mockRestore();
      }
    });

    it("returns default LLM runner when model is undefined", async () => {
      const spy = mockModelsDevGet();
      try {
        const llm = await resolveLLM(undefined);
        expect(llm).toBeDefined();
        expect(typeof llm.run).toBe("function");
      } finally {
        spy.mockRestore();
      }
    });

    it("falls back to default when custom model provider not found", async () => {
      const spy = mockModelsDevGet();
      try {
        const llm = await resolveLLM({
          providerID: "nonexistent-provider",
          modelID: "some-model",
        });
        expect(llm).toBeDefined();
        expect(typeof llm.run).toBe("function");
      } finally {
        spy.mockRestore();
      }
    });

    it("falls back to default when custom model ID not found", async () => {
      const spy = mockModelsDevGet();
      try {
        const llm = await resolveLLM({
          providerID: "anthropic",
          modelID: "nonexistent-model",
        });
        expect(llm).toBeDefined();
        expect(typeof llm.run).toBe("function");
      } finally {
        spy.mockRestore();
      }
    });

    it("throws when default model also fails", async () => {
      const spy = mockModelsDevGet({});
      try {
        await expect(resolveLLM(undefined)).rejects.toThrow(
          "Provider not found: anthropic",
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("resolveAgentForWorker", () => {
    it("returns complete config for existing agent", async () => {
      const spy = mockModelsDevGet();
      try {
        const config = await resolveAgentForWorker("explore");
        expect(config.llm).toBeDefined();
        expect(typeof config.llm.run).toBe("function");
        expect(config.input).toHaveProperty("system");
        expect(typeof (config.input as any).system).toBe("string");
        expect((config.input as any).system.length).toBeGreaterThan(0);
        expect(config.toolExecutor).toBeDefined();
        expect(config.toolExecutor).not.toBe(fallbackToolExecutor);
      } finally {
        spy.mockRestore();
      }
    });

    it("returns fallback config for nonexistent agent", async () => {
      const spy = mockModelsDevGet();
      try {
        const config = await resolveAgentForWorker("nonexistent-agent");
        expect(config.llm).toBeDefined();
        expect(typeof config.llm.run).toBe("function");
        expect(config.input).toEqual({});
        expect(config.toolExecutor).toBe(fallbackToolExecutor);
      } finally {
        spy.mockRestore();
      }
    });

    it("uses agent systemPrompt in input", async () => {
      const spy = mockModelsDevGet();
      try {
        const config = await resolveAgentForWorker("implement");
        expect((config.input as any).system).toContain(
          "expert software engineer",
        );
      } finally {
        spy.mockRestore();
      }
    });

    it("uses agent tools for toolExecutor", async () => {
      const spy = mockModelsDevGet();
      try {
        const config = await resolveAgentForWorker("explore");
        const results = await config.toolExecutor.execute([
          { id: "c1", tool: "read", input: {} },
          { id: "c2", tool: "write", input: {} },
        ]);
        expect(results[0].output).toContain("allowed but no executor");
        expect(results[1].output).toContain("not allowed");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("fallbackToolExecutor", () => {
    it("is exported and is a valid ToolExecutor", () => {
      expect(fallbackToolExecutor).toBeDefined();
      expect(typeof fallbackToolExecutor.execute).toBe("function");
    });

    it("returns error for every tool call", async () => {
      const results = await fallbackToolExecutor.execute([
        { id: "c1", tool: "bash", input: { command: "ls" } },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].isError).toBe(true);
      expect(results[0].output).toContain("bash");
      expect(results[0].output).toContain("not configured");
    });

    it("handles empty calls array", async () => {
      const results = await fallbackToolExecutor.execute([]);
      expect(results).toHaveLength(0);
    });
  });
});
