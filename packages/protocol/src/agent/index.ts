import { z } from "zod";
import { Guardrail } from "../guardrail/index.js";

export namespace AgentProfile {
  export const Definition = z.object({
    name: z.string(),
    description: z.string(),
    systemPrompt: z.string().optional(),
    tools: z.string().array().default([]),
    model: z
      .object({
        provider: z.string(),
        id: z.string(),
      })
      .optional(),
    permissions: Guardrail.ToolPermission.optional(),
    maxTurns: z.number().int().positive().optional(),
  });
  export type Definition = z.infer<typeof Definition>;
}
