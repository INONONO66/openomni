import { z } from "zod";

/** 32 lowercase hex characters (W3C trace id). */
type TraceId = string;

/**
 * Side-effect-free trace-id mint (W3C shape, nondeterministic by nature): `crypto.randomUUID()` is already 32 hex
 * once the dashes go. Lives in protocol so channel drivers can mint at the
 * first frame (D11 origin) without a telemetry import — gateway stage-1 seam
 * prep (#551); `@openomni/telemetry` re-exports it for its own consumers.
 */
export function newTraceId(): TraceId {
  return crypto.randomUUID().split("-").join("");
}

/**
 * #499: the correlation-header field set. `traceId`/`parentSpanId` correspond
 * to the W3C `traceparent` trace-id / parent-id fields; `sessionId`, `runId`,
 * and `agentName` are OpenOmni correlation dimensions (agentName is
 * load-bearing at the ingress/dispatch/run seams). This is protocol-owned and
 * deliberately NOT merged with telemetry's TraceScope (different owner
 * package); the two must stay field-compatible on the traceparent pair.
 */
export namespace TraceContext {
  const Schema = z.object({
    traceId: z.string(),
    sessionId: z.string().optional(),
    runId: z.string().optional(),
    agentName: z.string().optional(),
    parentSpanId: z.string().optional(),
  });
  export type Type = z.infer<typeof Schema>;
}
