import type { Database } from "bun:sqlite";
import { getDatabase } from "./database.js";
import { GENESIS_SEED, computeEventHash } from "./hash.js";
import { categoryOf, getNumberTraceField, getTraceField } from "./record-fields.js";
import { redactForPersistence } from "./redaction.js";
import type { PersistInput } from "./types.js";

/**
 * NORMAL/group-commit telemetry writer (#510 D1). Telemetry is observe-only
 * and lossy-tolerant by contract: rows are queued and flushed on the next
 * microtask as ONE transaction on the telemetry connection, so a burst of
 * Bus events costs one commit (one WAL sync at most under
 * synchronous=NORMAL) instead of one per event. bus_event/event_chain rows
 * are never a decision or authorization fact.
 */

/**
 * D11 — deliberate sentinel for events persisted without a traceId. A random
 * mint here would launder an untraceable event into a plausible trace inside
 * the ledger hash chain; refusing the row would drop the observe-only
 * projection's record entirely. The sentinel is a loud, grepable absence.
 */
const UNTRACED_TRACE_ID = "untraced";

interface QueueEntry {
  readonly db: Database;
  readonly input: PersistInput;
  readonly resolve: () => void;
  readonly reject: (err: unknown) => void;
}

let queue: QueueEntry[] = [];
let flushScheduled = false;

export function persist(input: PersistInput): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Resolve the connection in the caller's Storage scope — a flush may run
    // under a different AsyncLocalStorage isolation scope than the enqueue.
    const db = getDatabase();
    queue.push({ db, input, resolve, reject });
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flushPersistQueue);
    }
  });
}

/**
 * Drains the queued batch synchronously (group commit per connection, FIFO —
 * the per-session hash chain reads its tip inside the same transaction).
 * Exported for the shutdown drain; normally runs as the scheduled microtask.
 * Returns the number of entries drained so the shutdown barrier can detect
 * quiescence (a turn that drained nothing).
 */
export function flushPersistQueue(): number {
  flushScheduled = false;
  let drained = 0;
  while (queue.length > 0) {
    const batch = queue;
    queue = [];
    drained += batch.length;
    let start = 0;
    while (start < batch.length) {
      let end = start;
      while (end < batch.length && batch[end]?.db === batch[start]?.db) end += 1;
      flushGroup(batch.slice(start, end));
      start = end;
    }
  }
  return drained;
}

function flushGroup(entries: QueueEntry[]): void {
  const first = entries[0];
  if (first === undefined) return;
  const db = first.db;
  // BEGIN IMMEDIATE: the chain tip is read INSIDE the write transaction, so
  // take the write lock up front — a deferred read-then-upgrade can hit an
  // unretryable snapshot-invalidation busy against the other writer process.
  try {
    db.transaction(() => {
      for (const entry of entries) writeRow(db, entry.input);
    }).immediate();
    for (const entry of entries) entry.resolve();
  } catch {
    // Group commit failed — retry each row alone so one bad event stays a
    // single lossy drop instead of taking its batch-mates with it.
    for (const entry of entries) {
      try {
        db.transaction(() => writeRow(db, entry.input)).immediate();
        entry.resolve();
      } catch (err) {
        entry.reject(err);
      }
    }
  }
}

function writeRow(db: Database, input: PersistInput): void {
  const visibility = input.event.visibility ?? "internal";
  const data = JSON.stringify(
    redactForPersistence(input.payload === undefined ? null : input.payload),
  );
  const traceId = getTraceField(input.payload, "traceId") ?? UNTRACED_TRACE_ID;
  const runId = getTraceField(input.payload, "runId");
  const rawDurationMs = getNumberTraceField(input.payload, "durationMs");
  const durationMs =
    rawDurationMs !== undefined && Number.isFinite(rawDurationMs) ? rawDurationMs : undefined;
  const rawTimeCreated = getNumberTraceField(input.payload, "time");
  const fallbackTimeCreated = input.now().getTime();
  const timeCreated =
    rawTimeCreated !== undefined && Number.isFinite(rawTimeCreated)
      ? rawTimeCreated
      : finiteOrNow(fallbackTimeCreated);

  const prevHash = resolveChainTip(db, input.sessionId);
  const eventHash = computeEventHash({
    prevHash,
    eventType: input.event.name,
    data,
    traceId,
    timeCreated,
  });

  db.query(
    `INSERT INTO bus_event
       (session_id, run_id, event_type, category, visibility, data, payload_status,
        payload_diagnostic, trace_id, duration_ms, time_created, prev_hash, event_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sessionId ?? null,
    runId ?? null,
    input.event.name,
    categoryOf(input.event.name),
    visibility,
    data,
    input.payloadStatus,
    input.payloadDiagnostic ?? null,
    traceId,
    durationMs ?? null,
    timeCreated,
    prevHash,
    eventHash,
  );

  db.query(
    `INSERT INTO event_chain (session_id, event_type, event_hash, prev_hash, time_created)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.sessionId ?? null, input.event.name, eventHash, prevHash, timeCreated);
}

function resolveChainTip(db: Database, sessionId: string | undefined): string {
  const scope = sessionId ?? null;
  const row = db
    .query(
      sessionId === undefined
        ? "SELECT event_hash FROM bus_event WHERE session_id IS NULL ORDER BY id DESC LIMIT 1"
        : "SELECT event_hash FROM bus_event WHERE session_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(...(sessionId === undefined ? [] : [scope])) as { event_hash: string | null } | null;
  return row?.event_hash ?? GENESIS_SEED;
}

function finiteOrNow(value: number): number {
  return Number.isFinite(value) ? value : Date.now();
}
