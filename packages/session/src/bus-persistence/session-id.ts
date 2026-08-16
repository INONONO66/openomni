import type { Bus } from "@openomni/telemetry";
import { getOptionalDatabase } from "./database.js";
import { stringFromRecord, toRecord } from "./record-fields.js";

export function defaultResolveSessionId(
  _event: Bus.PublishedDescriptor,
  payload: unknown,
): string | undefined {
  const root = toRecord(payload);
  if (!root) return undefined;

  // NO root-level `id` fallback: `id` names the event's own subject (a
  // waitId, grantId, cron job id — or a just-deleted session, whose FK row is
  // gone). Attributing it as a sessionId FK-failed the insert and silently
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
 * #510 D2b run identity is fact-backed: a live run's worker session lives on
 * the WorkItem projection row (`workSessionId`/`workerRunId` — head ==
 * revision, every input carried by `work:` facts), so that is the canonical
 * read. Pre-freeze runs exist only as immutable `worker_run_state` rows; the
 * fallback is a read-only frozen-archive lookup (the store's writers throw
 * `worker_run_frozen`, so the table can never gain a new row).
 */
function sessionIdFromWorkerRun(record: Record<string, unknown> | undefined): string | undefined {
  const workerRunId = stringFromRecord(record, "workerRunId");
  if (!workerRunId) return undefined;
  const db = getOptionalDatabase();
  if (db === undefined) return undefined;
  try {
    const attemptBacked = db
      .query(
        `SELECT json_extract(data, '$.workSessionId') AS session_id
         FROM work_item
         WHERE json_extract(data, '$.workerRunId') = ?
         LIMIT 1`,
      )
      .get(workerRunId) as { session_id: string | null } | null;
    if (attemptBacked?.session_id) return attemptBacked.session_id;
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
