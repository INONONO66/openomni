/**
 * Trace identity, shaped so it can leave the process.
 *
 * The ids follow W3C Trace Context (and therefore OpenTelemetry): a 32-hex
 * `traceId` and a 16-hex `spanId`, lowercase, non-zero. That is not decoration
 * — a run that reaches an external server, a connector, or a machine over SSH
 * has to hand its trace across the boundary, and `traceparent` is the header
 * every other system already understands.
 *
 * The domain ids (`sessionId`, `runId`, `actorId`, `agentName`) ride alongside
 * as attributes. They are ours; the trace and span ids are not.
 */

export type TraceId = string;
export type SpanId = string;

export interface TraceScope {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  readonly sessionId: string;
  readonly runId: string;
  readonly actorId?: string;
  readonly agentName?: string;
}

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);
/**
 * Version 00 field layout. The version and the fields after the flags are
 * matched loosely on purpose — see {@link fromTraceparent}.
 */
const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const FORBIDDEN_TRACEPARENT_VERSION = "ff";

import { newTraceId } from "@openomni/protocol";
export { newTraceId };

export function newSpanId(): SpanId {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    // The all-zero span id is reserved as "invalid" by the spec. Retrying is
    // cheaper than reasoning about a 2^-64 event at every call site.
    if (id !== INVALID_SPAN_ID) return id;
  }
}

export function isTraceId(value: unknown): value is TraceId {
  return typeof value === "string" && TRACE_ID_PATTERN.test(value) && value !== INVALID_TRACE_ID;
}

export function isSpanId(value: unknown): value is SpanId {
  return typeof value === "string" && SPAN_ID_PATTERN.test(value) && value !== INVALID_SPAN_ID;
}

/**
 * The `traceparent` header for an outbound call. `01` is the sampled flag: we
 * record everything, so anything we hand out is sampled by definition.
 */
export function toTraceparent(scope: Pick<TraceScope, "traceId" | "spanId">): string {
  return `00-${scope.traceId}-${scope.spanId}-01`;
}

/**
 * Reads an inbound `traceparent`.
 *
 * Per W3C Trace Context §3.2.2.1 a higher version is parsed as version 00 when
 * the first 55 characters match, and fields after the flags are ignored. A
 * peer upgrading to a future version must not silently start a new trace —
 * that failure is invisible, and the trace it breaks is the one crossing the
 * boundary this exists for. Version `ff` is forbidden by the spec.
 *
 * Returns undefined for anything malformed: a caller joins a trace it can
 * verify, or starts its own.
 */
export function fromTraceparent(
  header: string | undefined,
): { readonly traceId: TraceId; readonly parentSpanId: SpanId } | undefined {
  const match = TRACEPARENT_PATTERN.exec(header?.trim() ?? "");
  if (match === null) return undefined;
  const [, version, traceId, parentSpanId, , trailing] = match;
  if (version === FORBIDDEN_TRACEPARENT_VERSION) return undefined;
  // Version 00's grammar is closed at 55 characters; trailing fields are
  // defined only for higher versions.
  if (version === "00" && trailing !== undefined) return undefined;
  if (!(isTraceId(traceId) && isSpanId(parentSpanId))) return undefined;
  return { traceId, parentSpanId };
}

/** Fields an emitter supplies. Never accepted from a payload. */
const TRACE_FIELDS = [
  "traceId",
  "spanId",
  "parentSpanId",
  "sessionId",
  "runId",
  "actorId",
  "agentName",
] as const;

type TraceField = (typeof TRACE_FIELDS)[number];

/** A payload with the emitter-owned fields removed. */
export type EmitPayload<T> = Omit<T, TraceField | "time">;

export class InvalidTraceScopeError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`telemetry scope is invalid: ${problems.join("; ")}`);
    this.name = "InvalidTraceScopeError";
    this.problems = problems;
  }
}

export interface TraceScopeInput {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly actorId?: string;
  readonly agentName?: string;
}

/**
 * Builds a scope, refusing an incomplete or malformed one.
 *
 * Emitting with a partial identity is worse than not emitting: the record
 * looks authoritative and correlates to nothing.
 *
 * `spanId` is minted when absent, because a root span has no caller to inherit
 * one from. `traceId` is not: a scope that cannot say which trace it belongs
 * to is the defect, not something to paper over.
 */
export function requireTraceScope(input: TraceScopeInput): TraceScope {
  const problems: string[] = [];
  if (!isTraceId(input.traceId)) problems.push("traceId must be 32 lowercase hex characters");
  if (input.spanId !== undefined && !isSpanId(input.spanId)) {
    problems.push("spanId must be 16 lowercase hex characters");
  }
  if (input.parentSpanId !== undefined && !isSpanId(input.parentSpanId)) {
    problems.push("parentSpanId must be 16 lowercase hex characters");
  }
  if (nonEmpty(input.sessionId) === undefined) problems.push("sessionId is required");
  if (nonEmpty(input.runId) === undefined) problems.push("runId is required");
  if (problems.length > 0) throw new InvalidTraceScopeError(problems);

  return {
    traceId: input.traceId as TraceId,
    spanId: input.spanId ?? newSpanId(),
    ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
    sessionId: input.sessionId as string,
    runId: input.runId as string,
    ...(nonEmpty(input.actorId) === undefined ? {} : { actorId: input.actorId as string }),
    ...(nonEmpty(input.agentName) === undefined ? {} : { agentName: input.agentName as string }),
  };
}

/**
 * Starts a fresh trace with a matching root span.
 *
 * A convenience over `newTraceId()` + `requireTraceScope`, for an origin that
 * wants an emitter immediately. Origins that only need the id — boot, ingress,
 * the manual driver — call `newTraceId()` directly.
 */
export function rootScope(input: Omit<TraceScopeInput, "traceId" | "parentSpanId">): TraceScope {
  return requireTraceScope({ ...input, traceId: newTraceId() });
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}
