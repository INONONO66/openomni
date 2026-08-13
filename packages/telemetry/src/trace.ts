/**
 * The identity every emitted event carries.
 *
 * An emitter owns its scope, so a caller cannot pass these fields — they are
 * removed from every payload type by {@link EmitPayload}. That is what makes a
 * fabricated `traceId` unexpressible rather than merely discouraged: before
 * this package, thirteen sites in the agent core minted a fresh
 * `crypto.randomUUID()` per event, and those events could never be correlated
 * back to the run that produced them.
 */
export interface TraceScope {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly actorId?: string;
  readonly agentName?: string;
}

/** Fields an emitter supplies. Never accepted from a payload. */
const TRACE_FIELDS = ["traceId", "sessionId", "runId", "actorId", "agentName"] as const;

export type TraceField = (typeof TRACE_FIELDS)[number];

/** A payload with the emitter-owned fields removed. */
export type EmitPayload<T> = Omit<T, TraceField | "time">;

export class MissingTraceScopeError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`telemetry scope requires ${missing.join(", ")}`);
    this.name = "MissingTraceScopeError";
    this.missing = missing;
  }
}

/**
 * Builds a scope, refusing an incomplete one.
 *
 * Emitting with a partial identity is worse than not emitting: the record
 * looks authoritative and correlates to nothing. Callers that cannot supply
 * the three required ids should not hold an emitter.
 */
export function requireTraceScope(candidate: {
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly actorId?: string;
  readonly agentName?: string;
}): TraceScope {
  const missing = (["traceId", "sessionId", "runId"] as const).filter(
    (field) => nonEmpty(candidate[field]) === undefined,
  );
  if (missing.length > 0) throw new MissingTraceScopeError(missing);

  return {
    traceId: candidate.traceId as string,
    sessionId: candidate.sessionId as string,
    runId: candidate.runId as string,
    ...(nonEmpty(candidate.actorId) === undefined ? {} : { actorId: candidate.actorId as string }),
    ...(nonEmpty(candidate.agentName) === undefined
      ? {}
      : { agentName: candidate.agentName as string }),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}
