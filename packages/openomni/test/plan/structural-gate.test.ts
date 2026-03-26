import { describe, expect, it } from "bun:test";
import type { Plan } from "@openomni/protocol";
import { StructuralGate } from "../../src/plan/structural-gate";

function makePlan(overrides?: Partial<Plan>): Plan {
  return {
    planId: "plan-1",
    goal: "Test goal",
    steps: [
      {
        stepId: "step-1",
        description: "Gather project requirements carefully",
        expectedOutput: "A concise requirement summary document",
        dependsOn: [],
        guardrail: "Use verified sources only",
      },
      {
        stepId: "step-2",
        description: "Design implementation steps in detail",
        expectedOutput: "A clear implementation checklist",
        dependsOn: ["step-1"],
        guardrail: "Do not skip dependency checks",
      },
    ],
    createdAt: new Date(),
    version: 1,
    ...overrides,
  };
}

describe("StructuralGate", () => {
  describe("Check 1: DAG validity", () => {
    it("passes for valid DAG", () => {
      const result = StructuralGate.evaluate(makePlan());
      expect(
        result.issues.find((issue) => issue.code === "invalid_dag"),
      ).toBeUndefined();
      expect(
        result.issues.find((issue) => issue.code === "circular_dependency"),
      ).toBeUndefined();
    });

    it("fails for circular dependency", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "a",
            description: "Create shared data model",
            expectedOutput: "A data model artifact",
            dependsOn: ["b"],
            guardrail: "Avoid breaking schema contracts",
          },
          {
            stepId: "b",
            description: "Update service API clients",
            expectedOutput: "Updated API client code",
            dependsOn: ["a"],
            guardrail: "Keep backward compatibility",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan);
      const cycleIssue = result.issues.find(
        (issue) => issue.code === "circular_dependency",
      );

      expect(cycleIssue).toBeDefined();
      expect(cycleIssue?.severity).toBe("error");
      expect(cycleIssue?.message.includes("a")).toBe(true);
      expect(cycleIssue?.message.includes("b")).toBe(true);
    });

    it("fails for invalid DAG (throws)", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "Assemble release notes for deploy",
            expectedOutput: "A release notes file",
            dependsOn: ["missing-step"],
            guardrail: "No fabricated references",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan);
      const invalidDagIssue = result.issues.find(
        (issue) => issue.code === "invalid_dag",
      );

      expect(invalidDagIssue).toBeDefined();
      expect(invalidDagIssue?.severity).toBe("error");
    });
  });

  describe("Check 2: Field completeness", () => {
    it("passes for complete fields", () => {
      const result = StructuralGate.evaluate(makePlan());
      expect(
        result.issues.find((issue) => issue.code === "empty_field"),
      ).toBeUndefined();
    });

    it("fails for empty description", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "   ",
            expectedOutput: "A concrete output statement",
            dependsOn: [],
            guardrail: "No unsafe operations",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan);
      const issue = result.issues.find(
        (candidate) => candidate.code === "empty_field",
      );

      expect(issue).toBeDefined();
      expect(issue?.stepId).toBe("step-1");
      expect(issue?.severity).toBe("error");
      expect(issue?.message.includes("description")).toBe(true);
    });

    it("fails for empty expectedOutput", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "Write detailed integration plan",
            expectedOutput: "",
            dependsOn: [],
            guardrail: "Keep constraints explicit",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan);
      const issue = result.issues.find(
        (candidate) => candidate.code === "empty_field",
      );

      expect(issue).toBeDefined();
      expect(issue?.stepId).toBe("step-1");
      expect(issue?.message.includes("expectedOutput")).toBe(true);
    });

    it("fails for missing guardrail when requireGuardrail: true", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "Prepare migration strategy document",
            expectedOutput: "Migration strategy with rollback",
            dependsOn: [],
            guardrail: "   ",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan, { requireGuardrail: true });
      const issue = result.issues.find(
        (candidate) => candidate.code === "missing_guardrail",
      );

      expect(issue).toBeDefined();
      expect(issue?.stepId).toBe("step-1");
      expect(issue?.severity).toBe("error");
    });
  });

  describe("Check 3: Step minimum quality", () => {
    it("passes for sufficient word count", () => {
      const result = StructuralGate.evaluate(makePlan(), {
        minDescriptionWords: 3,
        minExpectedOutputWords: 3,
      });

      expect(
        result.issues.find((issue) => issue.code === "low_quality_description"),
      ).toBeUndefined();
      expect(
        result.issues.find(
          (issue) => issue.code === "low_quality_expected_output",
        ),
      ).toBeUndefined();
    });

    it("warns for low word count description", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "short",
            expectedOutput: "Output contains enough words",
            dependsOn: [],
            guardrail: "Safety constraints enforced",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan, { minDescriptionWords: 3 });
      const issue = result.issues.find(
        (candidate) => candidate.code === "low_quality_description",
      );

      expect(issue).toBeDefined();
      expect(issue?.severity).toBe("warning");
      expect(issue?.stepId).toBe("step-1");
    });

    it("warns for low word count expectedOutput", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "Description has enough words here",
            expectedOutput: "tiny",
            dependsOn: [],
            guardrail: "Safety constraints enforced",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan, {
        minExpectedOutputWords: 3,
      });
      const issue = result.issues.find(
        (candidate) => candidate.code === "low_quality_expected_output",
      );

      expect(issue).toBeDefined();
      expect(issue?.severity).toBe("warning");
      expect(issue?.stepId).toBe("step-1");
    });
  });

  describe("Check 4: Duplicate detection", () => {
    it("passes for dissimilar steps", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "Gather incident context from monitoring dashboards",
            expectedOutput: "A complete incident context report",
            dependsOn: [],
            guardrail: "Use production-safe queries",
          },
          {
            stepId: "step-2",
            description: "Draft customer communication with timeline updates",
            expectedOutput: "A customer-ready status update",
            dependsOn: ["step-1"],
            guardrail: "Avoid speculative statements",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan, {
        duplicateThreshold: 0.85,
      });
      expect(
        result.issues.find((issue) => issue.code === "duplicate_steps"),
      ).toBeUndefined();
    });

    it("warns for similar steps above threshold", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "Draft release notes for new payment API rollout",
            expectedOutput: "Release notes draft",
            dependsOn: [],
            guardrail: "Do not expose internal keys",
          },
          {
            stepId: "step-2",
            description: "Draft release notes for the new payment api rollout",
            expectedOutput: "Second release notes draft",
            dependsOn: [],
            guardrail: "Do not expose secrets",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan, { duplicateThreshold: 0.8 });
      const issue = result.issues.find(
        (candidate) => candidate.code === "duplicate_steps",
      );

      expect(issue).toBeDefined();
      expect(issue?.severity).toBe("warning");
      expect(issue?.message.includes("step-1")).toBe(true);
      expect(issue?.message.includes("step-2")).toBe(true);
    });
  });

  describe("Check 5: Dependency depth", () => {
    it("passes for shallow chain", () => {
      const result = StructuralGate.evaluate(makePlan(), {
        maxDependencyDepth: 2,
      });
      expect(
        result.issues.find((issue) => issue.code === "deep_dependency_chain"),
      ).toBeUndefined();
    });

    it("warns for deep chain", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "s1",
            description: "Collect baseline telemetry data",
            expectedOutput: "Baseline telemetry snapshot",
            dependsOn: [],
            guardrail: "No destructive reads",
          },
          {
            stepId: "s2",
            description: "Review telemetry anomalies with context",
            expectedOutput: "Anomaly review report",
            dependsOn: ["s1"],
            guardrail: "Confirm data lineage",
          },
          {
            stepId: "s3",
            description: "Propose remediation actions for anomalies",
            expectedOutput: "Remediation proposal",
            dependsOn: ["s2"],
            guardrail: "Avoid unsafe remediation",
          },
          {
            stepId: "s4",
            description: "Prepare implementation sequence for remediation",
            expectedOutput: "Implementation sequence",
            dependsOn: ["s3"],
            guardrail: "Respect deployment policy",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan, { maxDependencyDepth: 2 });
      const issue = result.issues.find(
        (candidate) => candidate.code === "deep_dependency_chain",
      );

      expect(issue).toBeDefined();
      expect(issue?.severity).toBe("warning");
    });
  });

  describe("Check 6: Isolated step detection", () => {
    it("passes for connected steps", () => {
      const result = StructuralGate.evaluate(makePlan());
      expect(
        result.issues.find((issue) => issue.code === "isolated_step"),
      ).toBeUndefined();
    });

    it("warns for isolated step in multi-step plan", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "Build deployment checklist for release",
            expectedOutput: "Checklist artifact",
            dependsOn: [],
            guardrail: "Follow release standards",
          },
          {
            stepId: "step-2",
            description: "Execute deployment checklist with approvals",
            expectedOutput: "Deployment execution log",
            dependsOn: ["step-1"],
            guardrail: "Do not bypass approvals",
          },
          {
            stepId: "step-3",
            description: "Write an unrelated brainstorming memo",
            expectedOutput: "A brainstorming memo",
            dependsOn: [],
            guardrail: "No confidential details",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan);
      const issue = result.issues.find(
        (candidate) => candidate.code === "isolated_step",
      );

      expect(issue).toBeDefined();
      expect(issue?.severity).toBe("warning");
      expect(issue?.stepId).toBe("step-3");
    });

    it("does not warn for single-step plan", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "single",
            description: "Create one complete task definition",
            expectedOutput: "Task definition output",
            dependsOn: [],
            guardrail: "Keep scope constrained",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan);
      expect(
        result.issues.find((issue) => issue.code === "isolated_step"),
      ).toBeUndefined();
    });
  });

  describe("Overall behavior", () => {
    it("returns passed: true when only warnings (no errors)", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "short",
            expectedOutput: "enough expected output words",
            dependsOn: [],
            guardrail: "Guardrail exists",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan, { minDescriptionWords: 3 });
      expect(result.passed).toBe(true);
      expect(result.issues.some((issue) => issue.severity === "warning")).toBe(
        true,
      );
      expect(result.issues.some((issue) => issue.severity === "error")).toBe(
        false,
      );
    });

    it("returns passed: false when any error exists", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "   ",
            expectedOutput: "valid expected output",
            dependsOn: [],
            guardrail: "Guardrail exists",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan);
      expect(result.passed).toBe(false);
      expect(result.issues.some((issue) => issue.severity === "error")).toBe(
        true,
      );
    });

    it("collects all issues across all checks", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: " ",
            expectedOutput: " ",
            dependsOn: [],
            guardrail: "",
          },
          {
            stepId: "step-2",
            description: "tiny",
            expectedOutput: "tiny",
            dependsOn: [],
            guardrail: "Keep response grounded",
          },
          {
            stepId: "step-3",
            description: "tiny",
            expectedOutput: "tiny",
            dependsOn: [],
            guardrail: "Use verified assumptions",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan, {
        minDescriptionWords: 3,
        minExpectedOutputWords: 3,
        duplicateThreshold: 0.5,
        requireGuardrail: true,
      });

      expect(result.issues.some((issue) => issue.code === "empty_field")).toBe(
        true,
      );
      expect(
        result.issues.some((issue) => issue.code === "missing_guardrail"),
      ).toBe(true);
      expect(
        result.issues.some((issue) => issue.code === "low_quality_description"),
      ).toBe(true);
      expect(
        result.issues.some(
          (issue) => issue.code === "low_quality_expected_output",
        ),
      ).toBe(true);
      expect(
        result.issues.some((issue) => issue.code === "duplicate_steps"),
      ).toBe(true);
      expect(
        result.issues.some((issue) => issue.code === "isolated_step"),
      ).toBe(true);
    });

    it("skips duplicate and depth checks when DAG is invalid", () => {
      const plan = makePlan({
        steps: [
          {
            stepId: "step-1",
            description: "Duplicate duplicate wording content",
            expectedOutput: "Output with enough words",
            dependsOn: ["missing"],
            guardrail: "Guardrail exists",
          },
          {
            stepId: "step-2",
            description: "Duplicate duplicate wording content",
            expectedOutput: "Another valid expected output",
            dependsOn: [],
            guardrail: "Guardrail exists",
          },
        ],
      });

      const result = StructuralGate.evaluate(plan, {
        duplicateThreshold: 0.1,
        maxDependencyDepth: 0,
      });

      expect(result.issues.some((issue) => issue.code === "invalid_dag")).toBe(
        true,
      );
      expect(
        result.issues.some((issue) => issue.code === "duplicate_steps"),
      ).toBe(false);
      expect(
        result.issues.some((issue) => issue.code === "deep_dependency_chain"),
      ).toBe(false);
    });
  });
});
