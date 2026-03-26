import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ModelsDev } from "@openomni/llm";
import { BuiltinAgentRegistry } from "../../../src/legacy/agent/registry/registry";

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

let modelsCatalog: Record<string, ModelsDev.Provider> = {
  anthropic: FAKE_ANTHROPIC_PROVIDER,
};

const mockModelsGet = mock(async () => modelsCatalog);
const mockProviderFromModelsDevModel = mock((provider: { id: string }, model: { id: string }) => ({
  id: model.id,
  providerID: provider.id,
}));
const mockRun = mock(async () => ({ type: "stop" as const }));

mock.module("@openomni/llm", () => ({
  ModelsDev: { get: mockModelsGet },
  Provider: { fromModelsDevModel: mockProviderFromModelsDevModel },
  run: mockRun,
  TokenTracker: {
    extractUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
    calculateCost: () => ({ inputCost: 0, outputCost: 0, totalCost: 0 }),
  },
}));

let resolveAgentDefinition: typeof import("../../../src/legacy/worker/agent-resolution").resolveAgentDefinition;
let resolveLLM: typeof import("../../../src/legacy/worker/agent-resolution").resolveLLM;
let resolveToolExecutor: typeof import("../../../src/legacy/worker/agent-resolution").resolveToolExecutor;
let resolveAgentForWorker: typeof import("../../../src/legacy/worker/agent-resolution").resolveAgentForWorker;
let fallbackToolExecutor: typeof import("../../../src/legacy/worker/agent-resolution").fallbackToolExecutor;

beforeAll(async () => {
  ({
    resolveAgentDefinition,
    resolveLLM,
    resolveToolExecutor,
    resolveAgentForWorker,
    fallbackToolExecutor,
  } = await import("../../../src/legacy/worker/agent-resolution"));
});

beforeEach(() => {
  modelsCatalog = { anthropic: FAKE_ANTHROPIC_PROVIDER };
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
  mockRun.mockClear();

  BuiltinAgentRegistry.clear();
  BuiltinAgentRegistry.initializeBuiltins();
});

afterAll(() => {
  mock.restore();
});

describe("agent-resolution", () => {
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
      const results = await executor.execute([{ id: "call-1", tool: "write", input: {} }]);

      expect(results).toHaveLength(1);
      expect(results[0].isError).toBe(true);
      expect(results[0].output).toContain("not allowed");
      expect(results[0].output).toContain("read, grep");
    });

    it("accepts allowed tools with placeholder response", async () => {
      const executor = resolveToolExecutor(["read", "write"]);
      const results = await executor.execute([{ id: "call-1", tool: "read", input: {} }]);

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
      const results = await executor.execute([{ id: "my-call-id", tool: "read", input: {} }]);

      expect(results[0].toolCallId).toBe("my-call-id");
    });
  });

  describe("resolveLLM", () => {
    it("returns LLM runner for valid model config", async () => {
      const llm = await resolveLLM({
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
      });
      expect(llm).toBeDefined();
      expect(typeof llm.run).toBe("function");
    });

    it("returns default LLM runner when model is undefined", async () => {
      const llm = await resolveLLM(undefined);
      expect(llm).toBeDefined();
      expect(typeof llm.run).toBe("function");
    });

    it("falls back to default when custom model provider not found", async () => {
      const llm = await resolveLLM({
        providerID: "nonexistent-provider",
        modelID: "some-model",
      });
      expect(llm).toBeDefined();
      expect(typeof llm.run).toBe("function");
    });

    it("falls back to default when custom model ID not found", async () => {
      const llm = await resolveLLM({
        providerID: "anthropic",
        modelID: "nonexistent-model",
      });
      expect(llm).toBeDefined();
      expect(typeof llm.run).toBe("function");
    });

    it("throws when default model also fails", async () => {
      modelsCatalog = {};
      await expect(resolveLLM(undefined)).rejects.toThrow("Provider not found: anthropic");
    });
  });

  describe("resolveAgentForWorker", () => {
    it("returns complete config for existing agent", async () => {
      const config = await resolveAgentForWorker("explore");
      expect(config.llm).toBeDefined();
      expect(typeof config.llm.run).toBe("function");
      expect(config.input).toHaveProperty("system");
      if ("system" in config.input && typeof config.input.system === "string") {
        expect(config.input.system.length).toBeGreaterThan(0);
      }
      expect(config.toolExecutor).toBeDefined();
      expect(config.toolExecutor).not.toBe(fallbackToolExecutor);
    });

    it("returns fallback config for nonexistent agent", async () => {
      const config = await resolveAgentForWorker("nonexistent-agent");
      expect(config.llm).toBeDefined();
      expect(typeof config.llm.run).toBe("function");
      expect(config.input).toEqual({});
      expect(config.toolExecutor).toBe(fallbackToolExecutor);
    });

    it("uses agent systemPrompt in input", async () => {
      const config = await resolveAgentForWorker("implement");
      if ("system" in config.input && typeof config.input.system === "string") {
        expect(config.input.system).toContain("expert software engineer");
      }
    });

    it("uses agent tools for toolExecutor", async () => {
      const config = await resolveAgentForWorker("explore");
      const results = await config.toolExecutor.execute([
        { id: "c1", tool: "read", input: {} },
        { id: "c2", tool: "write", input: {} },
      ]);
      expect(results[0].output).toContain("allowed but no executor");
      expect(results[1].output).toContain("not allowed");
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
