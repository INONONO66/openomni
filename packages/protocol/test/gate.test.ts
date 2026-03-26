import { describe, expect, test as it } from "bun:test";
import { Gate } from "../src/gate/index.js";

describe("Gate schemas", () => {
  describe("Issue", () => {
    it("parses an error issue with stepId", () => {
      const result = Gate.Issue.parse({
        code: "E001",
        severity: "error",
        stepId: "step-1",
        message: "something failed",
      });

      expect(result).toEqual({
        code: "E001",
        severity: "error",
        stepId: "step-1",
        message: "something failed",
      });
    });

    it("parses a warning issue without stepId", () => {
      const result = Gate.Issue.parse({
        code: "W001",
        severity: "warning",
        message: "check this",
      });

      expect(result).toEqual({
        code: "W001",
        severity: "warning",
        message: "check this",
      });
    });

    it("rejects an invalid severity", () => {
      expect(() =>
        Gate.Issue.parse({
          code: "X001",
          severity: "info",
          message: "invalid",
        }),
      ).toThrow();
    });

    it("rejects a missing message", () => {
      expect(() =>
        Gate.Issue.parse({
          code: "X002",
          severity: "error",
        }),
      ).toThrow();
    });

    it("rejects a missing code", () => {
      expect(() =>
        Gate.Issue.parse({
          severity: "warning",
          message: "missing code",
        }),
      ).toThrow();
    });
  });

  describe("Verdict", () => {
    it("parses a passing verdict with empty issues", () => {
      const result = Gate.Verdict.parse({
        passed: true,
        issues: [],
      });

      expect(result).toEqual({
        passed: true,
        issues: [],
      });
    });

    it("parses a failing verdict with issues and feedback", () => {
      const result = Gate.Verdict.parse({
        passed: false,
        issues: [
          {
            code: "E100",
            severity: "error",
            message: "fix required",
          },
        ],
        feedback: "Please address the issue.",
      });

      expect(result).toEqual({
        passed: false,
        issues: [
          {
            code: "E100",
            severity: "error",
            message: "fix required",
          },
        ],
        feedback: "Please address the issue.",
      });
    });

    it("rejects a non-boolean passed value", () => {
      expect(() =>
        Gate.Verdict.parse({
          passed: 1,
          issues: [],
        }),
      ).toThrow();
    });

    it("rejects missing issues", () => {
      expect(() =>
        Gate.Verdict.parse({
          passed: true,
        }),
      ).toThrow();
    });
  });

  describe("Context", () => {
    it("rejects attempt 0", () => {
      expect(() =>
        Gate.Context.parse({
          goal: "deliver",
          attempt: 0,
        }),
      ).toThrow();
    });

    it("rejects attempt -1", () => {
      expect(() =>
        Gate.Context.parse({
          goal: "deliver",
          attempt: -1,
        }),
      ).toThrow();
    });

    it("rejects attempt 1.5", () => {
      expect(() =>
        Gate.Context.parse({
          goal: "deliver",
          attempt: 1.5,
        }),
      ).toThrow();
    });

    it("accepts attempt 1", () => {
      const result = Gate.Context.parse({
        goal: "deliver",
        attempt: 1,
      });

      expect(result).toEqual({
        goal: "deliver",
        attempt: 1,
      });
    });

    it("accepts attempt 100", () => {
      const result = Gate.Context.parse({
        goal: "deliver",
        attempt: 100,
      });

      expect(result.attempt).toBe(100);
    });

    it("accepts an empty goal string", () => {
      const result = Gate.Context.parse({
        goal: "",
        attempt: 1,
      });

      expect(result.goal).toBe("");
    });

    it("parses nested metadata objects", () => {
      const result = Gate.Context.parse({
        goal: "deliver",
        attempt: 2,
        metadata: {
          nested: {
            level: 1,
            flags: [true, false],
          },
        },
      });

      expect(result.metadata).toEqual({
        nested: {
          level: 1,
          flags: [true, false],
        },
      });
    });
  });
});
