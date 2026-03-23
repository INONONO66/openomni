import { describe, expect, it } from "bun:test";
import { EvaluationGate } from "../../src/team/evaluation-gate";

describe("EvaluationGate", () => {
  describe("evaluate", () => {
    it("returns score 0 and fails for empty actual output", () => {
      const result = EvaluationGate.evaluate("", "expected output");
      expect(result.score).toBe(0);
      expect(result.passed).toBe(false);
    });

    it("returns score 1 and passes when no expected output specified", () => {
      const result = EvaluationGate.evaluate("any output", "");
      expect(result.score).toBe(1);
      expect(result.passed).toBe(true);
    });

    it("returns score 1 for identical output", () => {
      const result = EvaluationGate.evaluate("hello world", "hello world");
      expect(result.score).toBe(1);
      expect(result.passed).toBe(true);
    });

    it("returns score between 0 and 1 for partial match", () => {
      const result = EvaluationGate.evaluate(
        "The function calculates sum",
        "Implement sum function",
      );
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
    });

    it("passes when score meets default threshold (0.5)", () => {
      const result = EvaluationGate.evaluate(
        "implement the sum function correctly",
        "implement sum function",
      );
      expect(result.passed).toBe(true);
    });

    it("fails when score is below custom passing threshold", () => {
      const result = EvaluationGate.evaluate(
        "something completely different",
        "implement sum function",
        { passingScore: 0.9 },
      );
      expect(result.passed).toBe(false);
    });

    it("includes score in feedback message", () => {
      const result = EvaluationGate.evaluate("output", "expected");
      expect(result.feedback).toContain("score:");
    });

    it("is case-insensitive", () => {
      const result1 = EvaluationGate.evaluate("HELLO WORLD", "hello world");
      const result2 = EvaluationGate.evaluate("hello world", "HELLO WORLD");
      expect(result1.score).toBe(result2.score);
    });
  });
});
