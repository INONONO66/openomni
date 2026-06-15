import type { Bus } from "../bus/index.js";
import { getOptionalDatabase } from "./database.js";
import { stringFromRecord, toRecord } from "./record-helpers.js";

export function defaultResolveSessionId(
  _event: Bus.PublishedDescriptor,
  payload: unknown,
): string | undefined {
  const root = toRecord(payload);
  if (!root) return undefined;

  const direct =
    sessionIdFromRecord(root) ??
    stringFromRecord(root, "originSessionId") ??
    sessionIdFromWorkerRun(root) ??
    stringFromRecord(root, "id");
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

function sessionIdFromWorkerRun(record: Record<string, unknown> | undefined): string | undefined {
  const workerRunId = stringFromRecord(record, "workerRunId");
  if (!workerRunId) return undefined;
  const db = getOptionalDatabase();
  if (db === undefined) return undefined;
  const row = db
    .query(
      `SELECT session_id
       FROM worker_run_state
       WHERE run_id = ?
       LIMIT 1`,
    )
    .get(workerRunId) as { session_id: string } | null;
  return row?.session_id;
}
