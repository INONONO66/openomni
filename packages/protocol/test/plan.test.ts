import { describe, test, expect } from "bun:test";
import {
  PlanStepSchema,
  PlanSchema,
  PlanResultSchema,
} from "../src/plan/index.js";

describe("PlanStep", () => {
  test("should parse valid step with required fields", () => {
    const step = PlanStepSchema.parse({
      stepId: "step-1",
      description: "Initialize project",
      expectedOutput: "Project initialized",
      dependsOn: [],
    });
    expect(step.stepId).toBe("step-1");
    expect(step.description).toBe("Initialize project");
    expect(step.expectedOutput).toBe("Project initialized");
    expect(step.dependsOn).toEqual([]);
  });

  test("should parse step with optional fields", () => {
    const step = PlanStepSchema.parse({
      stepId: "step-2",
      description: "Build API",
      expectedOutput: "API built",
      dependsOn: ["step-1"],
      suggestedAgent: "backend-agent",
      guardrail: "Ensure all endpoints are documented",
      tools: [
        {
          name: "npm",
          description: "Node package manager",
          inputSchema: { command: { type: "string" } },
        },
      ],
    });
    expect(step.stepId).toBe("step-2");
    expect(step.suggestedAgent).toBe("backend-agent");
    expect(step.guardrail).toBe("Ensure all endpoints are documented");
    expect(step.tools).toHaveLength(1);
    expect(step.tools?.[0].name).toBe("npm");
  });

  test("should default dependsOn to empty array", () => {
    const step = PlanStepSchema.parse({
      stepId: "step-1",
      description: "Test",
      expectedOutput: "Done",
    });
    expect(step.dependsOn).toEqual([]);
  });

  test("should reject missing required fields", () => {
    expect(() =>
      PlanStepSchema.parse({
        stepId: "step-1",
        description: "Test",
        // missing expectedOutput
      }),
    ).toThrow();
  });
});

describe("Plan", () => {
  test("should parse valid plan with empty steps", () => {
    const now = new Date();
    const plan = PlanSchema.parse({
      planId: "plan-1",
      goal: "Build a web application",
      steps: [],
      createdAt: now,
      version: 1,
    });
    expect(plan.planId).toBe("plan-1");
    expect(plan.goal).toBe("Build a web application");
    expect(plan.steps).toEqual([]);
    expect(plan.version).toBe(1);
  });

  test("should parse valid plan with steps and dependencies", () => {
    const now = new Date();
    const plan = PlanSchema.parse({
      planId: "plan-1",
      goal: "Build API",
      steps: [
        {
          stepId: "A",
          description: "Setup database",
          expectedOutput: "Database ready",
          dependsOn: [],
        },
        {
          stepId: "B",
          description: "Create API endpoints",
          expectedOutput: "Endpoints created",
          dependsOn: ["A"],
        },
      ],
      createdAt: now,
      version: 1,
    });
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[1].dependsOn).toEqual(["A"]);
  });

  test("should default version to 1", () => {
    const now = new Date();
    const plan = PlanSchema.parse({
      planId: "plan-1",
      goal: "Test",
      steps: [],
      createdAt: now,
    });
    expect(plan.version).toBe(1);
  });

  test("should reject plan with duplicate step IDs", () => {
    const now = new Date();
    expect(() =>
      PlanSchema.parse({
        planId: "plan-1",
        goal: "Build API",
        steps: [
          {
            stepId: "A",
            description: "Step A",
            expectedOutput: "Output A",
            dependsOn: [],
          },
          {
            stepId: "A",
            description: "Step A duplicate",
            expectedOutput: "Output A",
            dependsOn: [],
          },
        ],
        createdAt: now,
        version: 1,
      }),
    ).toThrow();
  });

  test("should reject plan with dependency on non-existent step", () => {
    const now = new Date();
    expect(() =>
      PlanSchema.parse({
        planId: "plan-1",
        goal: "Build API",
        steps: [
          {
            stepId: "A",
            description: "Step A",
            expectedOutput: "Output A",
            dependsOn: ["Z"],
          },
        ],
        createdAt: now,
        version: 1,
      }),
    ).toThrow();
  });

  test("should reject missing required fields", () => {
    const now = new Date();
    expect(() =>
      PlanSchema.parse({
        planId: "plan-1",
        // missing goal
        steps: [],
        createdAt: now,
      }),
    ).toThrow();
  });
});

describe("PlanResult", () => {
  test("should parse valid result with plan only", () => {
    const now = new Date();
    const plan = {
      planId: "plan-1",
      goal: "Build API",
      steps: [],
      createdAt: now,
      version: 1,
    };
    const result = PlanResultSchema.parse({
      plan,
    });
    expect(result.plan.planId).toBe("plan-1");
    expect(result.reviewNotes).toBeUndefined();
  });

  test("should parse result with review notes", () => {
    const now = new Date();
    const plan = {
      planId: "plan-1",
      goal: "Build API",
      steps: [],
      createdAt: now,
      version: 1,
    };
    const result = PlanResultSchema.parse({
      plan,
      reviewNotes: "Plan looks good, ready for execution",
    });
    expect(result.reviewNotes).toBe("Plan looks good, ready for execution");
  });

  test("should reject missing plan", () => {
    expect(() =>
      PlanResultSchema.parse({
        // missing plan
      }),
    ).toThrow();
  });
});
