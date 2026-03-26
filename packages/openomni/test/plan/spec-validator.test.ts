import { describe, expect, it } from "bun:test";
import type { Plan } from "@openomni/protocol";
import { SpecValidator } from "../../src/plan/spec-validator";

function makePlan(overrides?: Partial<Plan>): Plan {
  return {
    planId: "plan-1",
    goal: "Test goal",
    steps: [
      {
        stepId: "step-1",
        description: "First step",
        expectedOutput: "Output of step 1",
        dependsOn: [],
        guardrail: "No harmful content",
      },
      {
        stepId: "step-2",
        description: "Second step",
        expectedOutput: "Output of step 2",
        dependsOn: ["step-1"],
        guardrail: "No harmful content",
      },
    ],
    createdAt: new Date(),
    version: 1,
    ...overrides,
  };
}

describe("SpecValidator", () => {
  describe("strictness: off", () => {
    it("always returns valid with no issues", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "a",
            description: "step",
            expectedOutput: "",
            dependsOn: ["nonexistent"],
          },
        ],
      });
      const result = SpecValidator.validate(plan, { strictness: "off" });
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });

  describe("strictness: lenient (default)", () => {
    it("returns valid for a well-formed plan", () => {
      const result = SpecValidator.validate(makePlan());
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("detects dangling dependency", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "step",
            expectedOutput: "output",
            dependsOn: ["nonexistent"],
          },
        ],
      });
      const result = SpecValidator.validate(plan);
      expect(result.valid).toBe(false);
      const issue = result.issues.find((i) => i.code === "dangling_dependency");
      expect(issue).toBeDefined();
      expect(issue?.stepId).toBe("step-1");
    });

    it("detects circular dependency", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "a",
            description: "step a",
            expectedOutput: "output",
            dependsOn: ["b"],
          },
          {
            stepId: "b",
            description: "step b",
            expectedOutput: "output",
            dependsOn: ["a"],
          },
        ],
      });
      const result = SpecValidator.validate(plan);
      expect(result.valid).toBe(false);
      const issue = result.issues.find((i) => i.code === "circular_dependency");
      expect(issue).toBeDefined();
    });

    it("does not require guardrail in lenient mode", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "step",
            expectedOutput: "output",
            dependsOn: [],
          },
        ],
      });
      const result = SpecValidator.validate(plan, { strictness: "lenient" });
      expect(result.valid).toBe(true);
    });
  });

  describe("strictness: strict", () => {
    it("detects missing expectedOutput", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "step",
            expectedOutput: "",
            dependsOn: [],
            guardrail: "some guardrail",
          },
        ],
      });
      const result = SpecValidator.validate(plan, { strictness: "strict" });
      expect(result.valid).toBe(false);
      const issue = result.issues.find((i) => i.code === "missing_expected_output");
      expect(issue).toBeDefined();
      expect(issue?.stepId).toBe("step-1");
    });

    it("detects missing guardrail", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "step",
            expectedOutput: "output",
            dependsOn: [],
            guardrail: "",
          },
        ],
      });
      const result = SpecValidator.validate(plan, { strictness: "strict" });
      expect(result.valid).toBe(false);
      const issue = result.issues.find((i) => i.code === "missing_guardrail");
      expect(issue).toBeDefined();
    });

    it("passes for a fully specified plan", () => {
      const result = SpecValidator.validate(makePlan(), {
        strictness: "strict",
      });
      expect(result.valid).toBe(true);
    });
  });
});
