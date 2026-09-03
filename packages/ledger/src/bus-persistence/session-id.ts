import { getOptionalDatabase } from "./database.js";
import { stringFromRecord, toRecord } from "./record-fields.js";

export function defaultResolveSessionId(
  _event: { readonly name: string },
  payload: unknown,
): string | undefined {
  const root = toRecord(payload);
  if (!root) return undefined;

  // NO root-level `id` fallback: `id` names the event's own subject (a
  // waitId, a lookup-missed grantId — or a just-deleted session, whose FK row
  // is gone). Attributing it as a sessionId FK-failed the insert and silently
  // dropped the row; subject-scoped events belong to the sessionless chain.
  const direct =
    sessionIdFromRecord(root) ??
    stringFromRecord(root, "originSessionId") ??
    sessionIdFromWorkerRun(root);
  if (direct !== undefined) return direct;

  const nestedPayload = toRecord(root.payload);
  const nested = nestedPayload
    ? (sessionIdFromRecord(nestedPayload) ??
      stringFromRecord(nestedPayload, "originSessionId") ??
      sessionIdFromWorkerRun(nestedPayload) ??
      stringFromRecord(nestedPayload, "parentSessionId"))
    : undefined;
  if (nested !== undefined) return nested;

  const info = toRecord(root.info);
  return info
    ? (sessionIdFromRecord(info) ??
        stringFromRecord(info, "originSessionId") ??
        sessionIdFromWorkerRun(info) ??
        stringFromRecord(info, "id"))
    : undefined;
}

function sessionIdFromRecord(record: Record<string, unknown> | undefined): string | undefined {
  return stringFromRecord(record, "sessionId") ?? stringFromRecord(record, "sessionID");
}

/**
 * Telemetry session attribution for payloads that carry only a run id.
 * #510 D2b run identity is preserved only in immutable
 * `worker_run_state` rows. The lookup is read-only frozen-archive access. The
 * STORE's writers throw
 * `worker_run_frozen`, so no production path adds rows — but the table is
 * not immutable in the absolute: the adapter-layer writers still exist for
 * test seeding of historical rows (see WorkerRunStateStore doc).
 */
function sessionIdFromWorkerRun(record: Record<string, unknown> | undefined): string | undefined {
  const workerRunId = stringFromRecord(record, "workerRunId");
  if (!workerRunId) return undefined;
  const db = getOptionalDatabase();
  if (db === undefined) return undefined;
  try {
    const row = db
      .query(
        `SELECT session_id
         FROM worker_run_state
         WHERE run_id = ?
         LIMIT 1`,
      )
      .get(workerRunId) as { session_id: string } | null;
    return row?.session_id;
  } catch {
    return undefined;
  }
}
