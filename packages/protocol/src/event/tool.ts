import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const Base = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  runId: z.string().optional(),
  actor: z.record(z.string(), z.unknown()).optional(),
  toolCallId: z.string(),
  toolName: z.string(),
  time: z.number(),
});

export namespace ToolExecution {
  export const Started = BusEvent.define(
    "tool.execution.started",
    Base.extend({
      inputSummary: z.string().optional(),
    }),
    { visibility: "ephemeral" },
  );

  export const Completed = BusEvent.define(
    "tool.execution.completed",
    Base.extend({
      durationMs: z.number(),
      isError: z.boolean(),
    }),
    { visibility: "llm_reason" },
  );

  export const PermissionDenied = BusEvent.define(
    "tool.execution.permission_denied",
    Base.extend({
      reason: z.string(),
    }),
    { visibility: "llm_reason" },
  );

  export const TimedOut = BusEvent.define(
    "tool.execution.timed_out",
    Base.extend({
      timeoutMs: z.number(),
    }),
    { visibility: "llm_reason" },
  );
}
