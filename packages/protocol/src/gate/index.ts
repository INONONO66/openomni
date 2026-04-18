import { z } from "zod";
import { Plan } from "../plan/index.js";

export namespace Gate {
  export const Issue = z.object({
    code: z.string(),
    severity: z.enum(["error", "warning"]),
    stepId: z.string().optional(),
    message: z.string(),
  });
  export type Issue = z.infer<typeof Issue>;

  export const Verdict = z.object({
    passed: z.boolean(),
    issues: z.array(Issue),
    feedback: z.string().optional(),
  });
  export type Verdict = z.infer<typeof Verdict>;

  export const Context = z.object({
    goal: z.string(),
    attempt: z.number().int().min(1),
    previousFeedback: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  });
  export type Context = z.infer<typeof Context>;

  export interface Check {
    name: string;
    check(plan: Plan, context: Context): Promise<Verdict> | Verdict;
  }

  export const EnrichAction = z.object({
    type: z.enum(["added_step", "modified_step", "reordered", "added_dependency"]),
    stepId: z.string().optional(),
    description: z.string(),
  });
  export type EnrichAction = z.infer<typeof EnrichAction>;

  export const EnrichResult = z.object({
    plan: Plan.Schema,
    applied: z.array(EnrichAction),
  });
  export type EnrichResult = z.infer<typeof EnrichResult>;

  export interface Enricher {
    name: string;
    enrich(plan: Plan, context: Context): Promise<EnrichResult> | EnrichResult;
  }
}
