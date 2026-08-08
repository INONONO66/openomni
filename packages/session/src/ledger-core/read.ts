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
