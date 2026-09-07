import type { PlainValue } from "@openomni/protocol";
import { z } from "zod";

// JSON.parse returns a JSON value, not an alarm payload. No narrowing cast:
// the domain schema validates every field after this primitive boundary.
const decodeJson: (content: string) => PlainValue = JSON.parse;
const summary = z
  .object({
    alarmId: z.string().min(1),
    epoch: z.number().int().positive(),
    reason: z.enum(["exit", "timeout", "restart", "source_error"]),
    exitCode: z.number().int().nullable(),
  })
  .strict();
const pathEvent = z.object({ path: z.string(), event: z.enum(["create", "modify"]) }).strict();

export function alarmSummary(content: string): z.infer<typeof summary> {
  return summary.parse(decodeJson(content));
}

export function alarmPathEvent(content: string): z.infer<typeof pathEvent> {
  return pathEvent.parse(decodeJson(content));
}
