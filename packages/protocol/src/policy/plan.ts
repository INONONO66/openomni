import { z } from "zod";

export namespace PolicyPlanModule {
  export const PolicyPlan = z.object({
    policies: z.array(
      z.object({
        id: z.string().min(1),
        required: z.boolean(),
        config: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    labels: z.array(z.string()),
    registryVersion: z.string().optional(),
  });
  export type PolicyPlan = z.infer<typeof PolicyPlan>;
}
