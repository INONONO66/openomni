import type { Database } from "bun:sqlite";
import { getDatabase } from "./database.js";
import { GENESIS_SEED, computeEventHash } from "./hash.js";
import { categoryOf, getNumberTraceField, getTraceField } from "./record-helpers.js";
import { redactForPersistence } from "./redaction.js";
import type { PersistInput } from "./types.js";

export async function persist(input: PersistInput): Promise<void> {
  const db = getDatabase();
  const data = JSON.stringify(
    redactForPersistence(input.payload === undefined ? null : input.payload),
  );
  const traceId = getTraceField(input.payload, "traceId") ?? crypto.randomUUID();
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

  db.transaction(() => {
    db.query(
      `INSERT INTO bus_event
         (session_id, run_id, event_type, category, data, trace_id, duration_ms, time_created, prev_hash, event_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sessionId ?? null,
      runId ?? null,
      input.event.name,
      categoryOf(input.event.name),
      data,
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
  })();
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
