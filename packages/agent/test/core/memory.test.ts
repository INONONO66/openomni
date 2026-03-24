import { describe, expect, it, beforeEach } from "bun:test";
import { InMemoryMemory } from "../../src/core/memory";
import type { Memory } from "../../src/core/memory";

describe("InMemoryMemory", () => {
  let memory: InMemoryMemory;

  beforeEach(() => {
    memory = new InMemoryMemory();
  });

  describe("store", () => {
    it("stores entries that can be retrieved", async () => {
      await memory.store("k1", "hello world");
      const results = await memory.retrieve("hello world");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].key).toBe("k1");
      expect(results[0].content).toBe("hello world");
    });

    it("stores metadata alongside content", async () => {
      await memory.store("k1", "test content", { source: "user" });
      const results = await memory.retrieve("test content");
      expect(results[0].metadata).toEqual({ source: "user" });
    });
  });

  describe("retrieve", () => {
    beforeEach(async () => {
      await memory.store("k1", "the quick brown fox");
      await memory.store("k2", "the lazy dog sleeps");
      await memory.store("k3", "typescript programming language");
    });

    it("returns results sorted by descending score", async () => {
      const results = await memory.retrieve("the quick fox");
      expect(results.length).toBe(3);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it("scores exact match as 1.0", async () => {
      const results = await memory.retrieve("the quick brown fox");
      expect(results[0].key).toBe("k1");
      expect(results[0].score).toBe(1.0);
    });

    it("filters by threshold", async () => {
      const results = await memory.retrieve("the quick fox", {
        threshold: 0.5,
      });
      const allAbove = results.every((r) => r.score >= 0.5);
      expect(allAbove).toBe(true);
    });

    it("respects limit", async () => {
      const results = await memory.retrieve("the", { limit: 2 });
      expect(results.length).toBe(2);
    });

    it("returns empty for no match above threshold", async () => {
      const results = await memory.retrieve("typescript programming language", {
        threshold: 0.99,
      });
      const nonExact = results.filter((r) => r.key !== "k3");
      expect(nonExact.length).toBe(0);
    });

    it("returns all entries with default threshold 0.0", async () => {
      const results = await memory.retrieve("completely unrelated query xyz");
      expect(results.length).toBe(3);
    });

    it("defaults limit to 10", async () => {
      for (let i = 0; i < 15; i++) {
        await memory.store(`extra-${i}`, `word${i} content data`);
      }
      const results = await memory.retrieve("content");
      expect(results.length).toBe(10);
    });
  });

  describe("Jaccard similarity correctness", () => {
    it("computes correct Jaccard for known sets", async () => {
      await memory.store("k1", "a b c d");
      // query "a b c" vs stored "a b c d"
      // intersection = {a, b, c} = 3
      // union = {a, b, c, d} = 4
      // jaccard = 3/4 = 0.75
      const results = await memory.retrieve("a b c");
      expect(results[0].score).toBeCloseTo(0.75);
    });

    it("returns 0 for completely disjoint sets", async () => {
      await memory.store("k1", "alpha beta gamma");
      const results = await memory.retrieve("delta epsilon zeta");
      expect(results[0].score).toBe(0);
    });

    it("is case-insensitive", async () => {
      await memory.store("k1", "Hello World");
      const results = await memory.retrieve("hello world");
      expect(results[0].score).toBe(1.0);
    });

    it("handles empty query", async () => {
      await memory.store("k1", "some content");
      const results = await memory.retrieve("");
      expect(results[0].score).toBe(0);
    });
  });

  describe("clear", () => {
    it("removes all entries", async () => {
      await memory.store("k1", "hello");
      await memory.store("k2", "world");
      await memory.clear();
      const results = await memory.retrieve("hello");
      expect(results.length).toBe(0);
    });
  });

  describe("Memory interface compliance", () => {
    it("InMemoryMemory satisfies Memory interface", () => {
      const m: Memory = new InMemoryMemory();
      expect(typeof m.store).toBe("function");
      expect(typeof m.retrieve).toBe("function");
      expect(typeof m.clear).toBe("function");
    });
  });
});

describe("ChatAgent memory integration", () => {
  it("memory field is accepted in ChatAgentConfig", async () => {
    const { ChatAgent } = await import("../../src/core/chat-agent");

    const mockMemory: Memory = {
      store: async () => {},
      retrieve: async () => {
        return [{ key: "k1", content: "relevant context", score: 0.8 }];
      },
      clear: async () => {},
    };

    const agent = ChatAgent.create({
      model: { provider: "openai", id: "gpt-4" },
      memory: mockMemory,
    });

    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stream).toBe("function");
  });

  it("mock memory retrieve returns expected format", async () => {
    const mockMemory: Memory = {
      store: async () => {},
      retrieve: async (query: string) => {
        return [
          { key: "k1", content: `context for: ${query}`, score: 0.9 },
          { key: "k2", content: "secondary context", score: 0.5 },
        ];
      },
      clear: async () => {},
    };

    const results = await mockMemory.retrieve("test query");
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("context for: test query");
    expect(results[0].score).toBe(0.9);
  });
});
