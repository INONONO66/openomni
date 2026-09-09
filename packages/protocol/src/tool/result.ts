import { z } from "zod";

/** Fresh schemas keep policy validation isolated from mutation of public Tool.Result. */
export function toolResultSchema() {
  return z.object({
    id: z.string(),
    toolCallId: z.string(),
    // Additive-optional denormalized name; historical results may only have the call id.
    toolName: z.string().optional(),
    output: z.string(),
    isError: z.boolean().optional(),
    settlement: z.enum(["settled", "unknown"]).optional(),
  });
}
