import { z } from "zod";

export const CategoryConfig = z.object({
  name: z.string(),
  description: z.string(),
  agentHints: z.array(z.string()).optional(),
  toolHints: z.array(z.string()).optional(),
  promptAppend: z.string().optional(),
});

export type CategoryConfig = z.infer<typeof CategoryConfig>;

export interface CategoryResolution {
  config: CategoryConfig;
  source: "builtin" | "custom" | "fallback";
}
