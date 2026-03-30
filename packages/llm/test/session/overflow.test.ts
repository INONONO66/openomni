import { describe, expect, test } from "bun:test";
import { Overflow } from "../../src/session/overflow";

describe("Overflow.detect", () => {
  describe("Anthropic patterns", () => {
    test("matches 'prompt is too long'", () => {
      expect(Overflow.detect(new Error("prompt is too long: 150000 tokens > 128000"))).toBe(true);
    });

    test("matches 'exceeds the context window'", () => {
      expect(
        Overflow.detect(new Error("This request exceeds the context window for this model")),
      ).toBe(true);
    });

    test("matches 'exceeds the maximum'", () => {
      expect(Overflow.detect(new Error("Your input exceeds the maximum number of tokens"))).toBe(
        true,
      );
    });
  });

  describe("OpenAI patterns", () => {
    test("matches 'context_length_exceeded'", () => {
      expect(Overflow.detect(new Error("context_length_exceeded"))).toBe(true);
    });

    test("matches 'maximum context length is N tokens'", () => {
      expect(
        Overflow.detect(
          new Error(
            "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.",
          ),
        ),
      ).toBe(true);
    });

    test("matches 'request entity too large'", () => {
      expect(Overflow.detect(new Error("Request entity too large"))).toBe(true);
    });
  });

  describe("case insensitivity", () => {
    test("matches uppercase", () => {
      expect(Overflow.detect(new Error("PROMPT IS TOO LONG"))).toBe(true);
    });

    test("matches mixed case", () => {
      expect(Overflow.detect(new Error("Prompt Is Too Long"))).toBe(true);
    });
  });

  describe("non-matching inputs", () => {
    test("returns false for empty string", () => {
      expect(Overflow.detect(new Error(""))).toBe(false);
    });

    test("returns false for unrelated error", () => {
      expect(Overflow.detect(new Error("rate limit exceeded"))).toBe(false);
    });

    test("returns false for partial matches", () => {
      expect(Overflow.detect(new Error("prompt"))).toBe(false);
    });

    test("returns false for generic server error", () => {
      expect(Overflow.detect(new Error("Internal server error"))).toBe(false);
    });
  });

  describe("input type handling", () => {
    test("handles Error objects", () => {
      expect(Overflow.detect(new Error("prompt is too long"))).toBe(true);
    });

    test("handles plain strings", () => {
      expect(Overflow.detect("prompt is too long")).toBe(true);
    });

    test("handles non-Error non-string values", () => {
      expect(Overflow.detect(42)).toBe(false);
      expect(Overflow.detect(null)).toBe(false);
      expect(Overflow.detect(undefined)).toBe(false);
    });

    test("handles objects with toString", () => {
      const obj = { toString: () => "prompt is too long" };
      expect(Overflow.detect(obj)).toBe(true);
    });
  });
});
