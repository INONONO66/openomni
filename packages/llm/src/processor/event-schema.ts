import { PlainObjectSchema } from "@openomni/protocol";
import { z } from "zod";
import { UsageResponse } from "../token/schema";

/** Only consumed wire fields cross into transcript projection. Accounting has its own decoder. */
export const ProviderEvent = z.object({
  type: z.string(),
  id: z.string().optional(),
  text: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  input: PlainObjectSchema.optional(),
  output: z.json().optional(),
  isError: z.boolean().optional(),
  message: z.string().optional(),
  finishReason: z.string().optional(),
  providerMetadata: PlainObjectSchema.optional(),
  usage: UsageResponse.shape.usage.optional(),
  error: z.unknown().optional(),
});
export type ProviderEvent = z.infer<typeof ProviderEvent>;

export const OutputPayload = z.object({
  output: z.json().optional(),
  isError: z.boolean().optional(),
});

export const Signature = z.object({ signature: z.string().optional() });
