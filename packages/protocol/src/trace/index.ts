import { z } from "zod";

/** 32 lowercase hex characters (W3C trace id). */
export type TraceId = string;

/**
 * Side-effect-free trace-id mint (W3C shape, nondeterministic by nature): `crypto.randomUUID()` is already 32 hex
 * once the dashes go. Lives in protocol so channel drivers can mint at the
 * first frame (D11 origin) without a telemetry import — gateway stage-1 seam
 * prep (#551); `@openomni/telemetry` re-exports it for its own consumers.
 */
export function newTraceId(): TraceId {
  return crypto.randomUUID().split("-").join("");
}

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
