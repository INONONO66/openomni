import { z } from "zod";
import { Tool } from "../tool/index.js";

export const PlanStepSchema = z.object({
  stepId: z.string(),
  description: z.string(),
  expectedOutput: z.string(),
  dependsOn: z.array(z.string()).default([]),
  suggestedAgent: z.string().optional(),
  guardrail: z.string().optional(),
  tools: z.array(Tool.Spec).optional(),
  requiresApproval: z.boolean().optional(),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z
  .object({
    planId: z.string(),
    goal: z.string(),
    steps: z.array(PlanStepSchema),
    createdAt: z.date(),
    version: z.number().int().default(1),
  })
  .superRefine((data, ctx) => {
    // Check for duplicate step IDs
    const stepIds = data.steps.map((s) => s.stepId);
    const uniqueIds = new Set(stepIds);
    if (stepIds.length !== uniqueIds.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Step IDs must be unique",
        path: ["steps"],
      });
    }

    // Check that all dependencies reference existing steps
    const stepIdSet = new Set(stepIds);
    for (const step of data.steps) {
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
  });

export type Plan = z.infer<typeof PlanSchema>;

export const PlanConfigSchema = z.object({
  model: z.object({
    provider: z.string(),
    id: z.string(),
  }),
  systemPrompt: z.string().optional(),
  reviewPrompt: z.string().optional(),
});

export type PlanConfig = z.infer<typeof PlanConfigSchema>;

export const PlanResultSchema = z.object({
  plan: PlanSchema,
  reviewNotes: z.string().optional(),
});

export type PlanResult = z.infer<typeof PlanResultSchema>;
