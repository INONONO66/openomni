import { z } from "zod";
import { Tool } from "../tool/index.js";

export namespace Plan {
  export const StepSchema = z.object({
    stepId: z.string(),
    description: z.string(),
    expectedOutput: z.string(),
    dependsOn: z.array(z.string()).default([]),
    suggestedAgent: z.string().optional(),
    guardrail: z.string().optional(),
    tools: z.array(Tool.Spec).optional(),
    requiresApproval: z.boolean().optional(),
  });
  export type Step = z.infer<typeof StepSchema>;

  export const Schema = z
    .object({
      planId: z.string(),
      goal: z.string(),
      steps: z.array(StepSchema),
      createdAt: z.coerce.date(),
      version: z.number().int().default(1),
    })
    .superRefine((data, ctx) => {
      const stepIds = data.steps.map((s) => s.stepId);
      const uniqueIds = new Set(stepIds);
      if (stepIds.length !== uniqueIds.size) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Step IDs must be unique",
          path: ["steps"],
        });
        return;
      }

      const stepIdSet = new Set(stepIds);
      const deps = new Map<string, string[]>();
      for (const step of data.steps) {
        deps.set(step.stepId, step.dependsOn);
        for (const dep of step.dependsOn) {
          if (!stepIdSet.has(dep)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Step "${step.stepId}" depends on non-existent step "${dep}"`,
              path: ["steps"],
            });
          }
        }
      }

      // Kahn's algorithm for cycle detection
      const inDegree = new Map<string, number>();
      for (const id of stepIds) inDegree.set(id, 0);
      for (const step of data.steps) {
        for (const dep of step.dependsOn) {
          inDegree.set(step.stepId, (inDegree.get(step.stepId) ?? 0) + 1);
          void dep;
        }
      }

      const queue = stepIds.filter((id) => inDegree.get(id) === 0);
      let visited = 0;
      while (queue.length > 0) {
        const id = queue.shift();
        if (id === undefined) break;
        visited++;
        for (const step of data.steps) {
          if (step.dependsOn.includes(id)) {
            const deg = (inDegree.get(step.stepId) ?? 1) - 1;
            inDegree.set(step.stepId, deg);
            if (deg === 0) queue.push(step.stepId);
          }
        }
      }

      if (visited !== stepIds.length) {
        const cycled = stepIds.filter((id) => (inDegree.get(id) ?? 0) > 0);
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Dependency cycle detected involving steps: ${cycled.join(", ")}`,
          path: ["steps"],
        });
      }
    });

  export const ResultSchema = z.object({
    planId: z.string(),
  });
  export type Result = z.infer<typeof ResultSchema>;
}

// declaration merging: `Plan` is both a namespace and a type
export type Plan = z.infer<typeof Plan.Schema>;
