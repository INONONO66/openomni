
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
  // A plain type, not a Zod schema: every consumer propagates this
  // structurally (no runtime validation seam exists), so a schema here
  // would be dead runtime weight.
  export type Type = {
    traceId: string;
    sessionId?: string | undefined;
    runId?: string | undefined;
    agentName?: string | undefined;
    parentSpanId?: string | undefined;
  };
}
