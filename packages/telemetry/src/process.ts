import { newTraceId, requireTraceScope, type TraceScope } from "./trace";

/**
 * The trace for events that belong to no request.
 *
 * Bootstrap, shutdown, config loading, and worker supervision all emit outside
 * any run. Before this, each such site minted its own `crypto.randomUUID()` —
 * 127 of them — so a process that logged a hundred startup facts produced a
 * hundred unrelated traces. Correlating anything was impossible, which is the
 * one thing a trace id exists to make possible.
 *
 * They share one trace instead. `sessionId` and `runId` name the process
 * lifetime rather than a conversation, because that is what these events are
 * scoped to and pretending otherwise would file them under a session that does
 * not exist.
 */
let current: TraceScope | undefined;

export function processScope(): TraceScope {
  current ??= requireTraceScope({
    traceId: newTraceId(),
    sessionId: PROCESS_SESSION_ID,
    runId: PROCESS_RUN_ID,
  });
  return current;
}

/** The literal a reader sees in place of a session id on process-scoped rows. */
export const PROCESS_SESSION_ID = "process";
/** The literal a reader sees in place of a run id on process-scoped rows. */
export const PROCESS_RUN_ID = "process";

/**
 * Starts a new process trace. Tests call this between cases; production calls
 * it never — a process has one lifetime.
 */
export function resetProcessScope(): void {
  current = undefined;
}
