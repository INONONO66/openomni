import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const Base = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  time: z.number(),
});

export namespace ToolExecution {
  export const Started = BusEvent.define("tool.execution.started", Base);

  export const Completed = BusEvent.define(
    "tool.execution.completed",
    Base.extend({
      durationMs: z.number(),
      isError: z.boolean(),
    }),
  );

  export const PermissionDenied = BusEvent.define(
    "tool.permission.denied",
    Base.extend({
      reason: z.string(),
    }),
  );

  export const TimedOut = BusEvent.define(
    "tool.execution.timed_out",
    Base.extend({
      timeoutMs: z.number(),
    }),
  );
}
