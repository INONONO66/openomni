import { z } from "zod";

export namespace TraceContext {
  const Schema = z.object({
    traceId: z.string(),
    sessionId: z.string().optional(),
    runId: z.string().optional(),
    taskId: z.string().optional(),
    agentName: z.string().optional(),
    parentSpanId: z.string().optional(),
  });
  export type Type = z.infer<typeof Schema>;
}
