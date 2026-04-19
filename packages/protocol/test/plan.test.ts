import { describe, test, expect } from "bun:test";
import { Plan } from "../src/plan/index.js";

describe("PlanStep", () => {
  test("should parse valid step with required fields", () => {
    const step = Plan.StepSchema.parse({
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
    const step = Plan.StepSchema.parse({
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
    const step = Plan.StepSchema.parse({
      stepId: "step-1",
      description: "Test",
      expectedOutput: "Done",
    });
    expect(step.dependsOn).toEqual([]);
  });

  test("should reject missing required fields", () => {
    expect(() =>
      Plan.StepSchema.parse({
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
    const plan = Plan.Schema.parse({
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
    const plan = Plan.Schema.parse({
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
    const plan = Plan.Schema.parse({
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
      Plan.Schema.parse({
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
      Plan.Schema.parse({
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
      Plan.Schema.parse({
        planId: "plan-1",
        // missing goal
        steps: [],
        createdAt: now,
      }),
    ).toThrow();
  });
});

describe("PlanResult", () => {
  test("should parse valid result with planId", () => {
    const result = Plan.ResultSchema.parse({ planId: "plan-1" });
    expect(result.planId).toBe("plan-1");
  });

  test("should reject missing planId", () => {
    expect(() => Plan.ResultSchema.parse({})).toThrow();
  });

  test("should reject non-string planId", () => {
    expect(() => Plan.ResultSchema.parse({ planId: 123 })).toThrow();
  });
});

describe("version constraint (.int() only)", () => {
  test("rejects float version", () => {
    const now = new Date();
    expect(() =>
      Plan.Schema.parse({
        planId: "p",
        goal: "g",
        steps: [],
        createdAt: now,
        version: 1.5,
      }),
    ).toThrow();
  });

  test("accepts version 0 (no positive constraint)", () => {
    const now = new Date();
    expect(() =>
      Plan.Schema.parse({
        planId: "p",
        goal: "g",
        steps: [],
        createdAt: now,
        version: 0,
      }),
    ).not.toThrow();
  });
});

describe("cycle detection", () => {
  test("rejects self-dependency A→A", () => {
    const now = new Date();
    expect(() =>
      Plan.Schema.parse({
        planId: "p",
        goal: "g",
        steps: [
          {
            stepId: "A",
            description: "d",
            expectedOutput: "o",
            dependsOn: ["A"],
          },
        ],
        createdAt: now,
        version: 1,
      }),
    ).toThrow();
  });

  test("rejects circular dependency A→B→A", () => {
    const now = new Date();
    expect(() =>
      Plan.Schema.parse({
        planId: "p",
        goal: "g",
        steps: [
          {
            stepId: "A",
            description: "d",
            expectedOutput: "o",
            dependsOn: ["B"],
          },
          {
            stepId: "B",
            description: "d",
            expectedOutput: "o",
            dependsOn: ["A"],
          },
        ],
        createdAt: now,
        version: 1,
      }),
    ).toThrow();
  });

  test("z.coerce.date() survives JSON round-trip", () => {
    const now = new Date();
    const plan = {
      planId: "p",
      goal: "g",
      steps: [],
      createdAt: now,
      version: 1,
    };
    const json = JSON.stringify(plan);
    const parsed = Plan.Schema.parse(JSON.parse(json));
    expect(parsed.createdAt.getTime()).toBe(now.getTime());
  });
});
