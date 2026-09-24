import { z } from "zod";
import { PlainValueSchema } from "../json.js";
import { PolicyEffects } from "./effects.js";

export const PolicyRef = z.string().regex(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/);

const BudgetFields = {
  metric: z.enum([
    "continuation",
    "fanout",
    "exact_repeat",
    "toolless_stall",
    "blocked_recurrence",
    "resume",
    "notifications",
  ]),
  limit: z.number().int().positive(),
};

/** Executable row data, distinct from the permission engine's PolicyDecision. */
export const RowVerdict = PlainValueSchema.pipe(
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("allow"),
        reason: z.string().optional(),
        reasonCodes: z.array(z.string()).optional(),
        effects: z.array(PolicyEffects.PolicyEffect).optional(),
      })
      .strict(),
    z.object({ type: z.literal("deny"), reason: z.string().optional() }).strict(),
    z.object({ type: z.literal("require_approval"), reason: z.string().min(1) }).strict(),
    z
      .object({ type: z.literal("transform"), ref: PolicyRef, config: PlainValueSchema.optional() })
      .strict(),
    z.object({ type: z.literal("obligation"), ref: PolicyRef, ...BudgetFields }).strict(),
  ]),
);
export type RowVerdict = z.infer<typeof RowVerdict>;

const HistoricRedact = z
  .object({
    type: z.literal("transform"),
    name: z.literal("redact"),
    paths: z.array(z.string().min(1)).default([]),
    replacement: PlainValueSchema.optional(),
  })
  .strict()
  .transform((value) => ({
    type: "transform" as const,
    ref: "kernel/redact",
    config: {
      paths: value.paths,
      ...(value.replacement === undefined ? {} : { replacement: value.replacement }),
    },
  }));
const HistoricBudget = z
  .object({
    type: z.literal("obligation"),
    name: z.literal("budget_clamp"),
    ...BudgetFields,
  })
  .strict()
  .transform((value) => ({
    type: "obligation" as const,
    ref: "kernel/budget-clamp",
    metric: value.metric,
    limit: value.limit,
  }));

/** Frozen historical grammar. Decode for execution only; hash/store the original row bytes. */
export const RowVerdictRead = PlainValueSchema.pipe(
  z.union([RowVerdict, HistoricRedact, HistoricBudget]),
);

export const PolicyTransform = z.object({ ruleId: z.string().min(1), ref: PolicyRef }).strict();
export type PolicyTransform = z.infer<typeof PolicyTransform>;
