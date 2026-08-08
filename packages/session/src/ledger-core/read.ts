import type { Database } from "bun:sqlite";
import { LedgerAppend } from "@openomni/protocol";

/**
 * Minimal read API of the append core (#510 C3): the newest recorded fact of
 * ONE stream, as a raw prepared SELECT on the same connection discipline as
 * the write path. For a single-fact decision stream (`route:<id>`) the head
 * fact IS the recorded decision — the replay path re-executes from it
 * instead of re-deciding, so a redelivered inbound replays the same recorded
 * outcome (accepted routes re-run idempotently, terminal decisions repeat
 * their typed rejection). Returns undefined for an empty stream.
 */
export function headFact(db: Database, streamId: string): LedgerAppend.RecordedFact | undefined {
  const row = db
    .query(
      "SELECT seq, type, data, time_created FROM ledger_event WHERE stream_id = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(streamId) as { seq: number; type: string; data: string; time_created: number } | null;
  if (!row) return undefined;
  // Service-entry enforcement layer: the stored row must round-trip the
  // RecordedFact shape — a foreign or corrupt row fails loudly here.
  return LedgerAppend.RecordedFact.parse({
    streamId,
    seq: row.seq,
    type: row.type,
    data: JSON.parse(row.data),
    timeCreated: row.time_created,
  });
}

/**
 * Every recorded fact of ONE type across all streams, ordered by
 * (streamId, seq) — the #510 D3 admin inspection read (`/admin/ledger/*`).
 * Read-only: same prepared-SELECT discipline as {@link headFact}.
 */
export function factsByType(db: Database, type: string): LedgerAppend.RecordedFact[] {
  const rows = db
    .query(
      "SELECT stream_id, seq, type, data, time_created FROM ledger_event WHERE type = ? ORDER BY stream_id ASC, seq ASC",
    )
    .all(type) as {
    stream_id: string;
    seq: number;
    type: string;
    data: string;
    time_created: number;
  }[];
  return rows.map((row) =>
    LedgerAppend.RecordedFact.parse({
      streamId: row.stream_id,
      seq: row.seq,
      type: row.type,
      data: JSON.parse(row.data),
      timeCreated: row.time_created,
    }),
  );
}
