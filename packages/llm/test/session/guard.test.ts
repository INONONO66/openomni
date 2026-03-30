import { describe, expect, test } from "bun:test";
import { Guard } from "../../src/session/guard";

describe("Guard", () => {
  describe("isDoomLoop", () => {
    test("returns true for the third identical tool call", () => {
      const history: Guard.ToolCallRecord[] = [
        { tool: "search", inputHash: '{"query":"openomni"}' },
        { tool: "search", inputHash: '{"query":"openomni"}' },
      ];

      expect(Guard.isDoomLoop(history, { tool: "search", inputHash: '{"query":"openomni"}' })).toBe(
        true,
      );
    });

    test("returns false for only two identical calls", () => {
      const history: Guard.ToolCallRecord[] = [
        { tool: "search", inputHash: '{"query":"openomni"}' },
      ];

      expect(Guard.isDoomLoop(history, { tool: "search", inputHash: '{"query":"openomni"}' })).toBe(
        false,
      );
    });

    test("returns false when tool names differ", () => {
      const history: Guard.ToolCallRecord[] = [
        { tool: "search", inputHash: '{"query":"openomni"}' },
        { tool: "lookup", inputHash: '{"query":"openomni"}' },
      ];

      expect(Guard.isDoomLoop(history, { tool: "search", inputHash: '{"query":"openomni"}' })).toBe(
        false,
      );
    });

    test("returns false when inputs differ", () => {
      const history: Guard.ToolCallRecord[] = [
        { tool: "search", inputHash: '{"query":"openomni"}' },
        { tool: "search", inputHash: '{"query":"agent"}' },
      ];

      expect(Guard.isDoomLoop(history, { tool: "search", inputHash: '{"query":"openomni"}' })).toBe(
        false,
      );
    });

    test("returns false for empty history", () => {
      expect(Guard.isDoomLoop([], { tool: "search", inputHash: "{}" })).toBe(false);
    });
  });

  describe("hashInput", () => {
    test("returns stable hash for equivalent input", () => {
      const inputA = { query: "openomni", limit: 3 };
      const inputB = { query: "openomni", limit: 3 };

      expect(Guard.hashInput(inputA)).toBe(Guard.hashInput(inputB));
      expect(Guard.hashInput(inputA)).toBe('{"query":"openomni","limit":3}');
    });
  });
});
