import type { Database } from "bun:sqlite";
import { LedgerAppend } from "@openomni/protocol";
import { GENESIS_SEED } from "../bus-persistence/hash";
import { computeLedgerEventHash } from "./hash";

/**
 * Serialized CAS append — the one write path of the #510 clean ledger.
 *
 * Raw prepared statements inside a sync `behavior "immediate"` transaction
 * (decision-class rule: no ORM, no async callback on the write path). The
 * CAS receipt is `changes === 1` on the head bump; the hash chain is
 * computed inside the same transaction from the freshly read tip, so a
 * committed row is chained by construction.
 *
 * Outcomes are typed, never thrown: `appended {seq, eventHash}` or
 * `cas_conflict {currentHead}` (which guarantees nothing was written).
 * Retrying from the reported head is the CALLER's decision. The composite
 * PK (stream_id, seq) is the explosive backstop — any write that bypasses
 * the CAS onto an occupied seq throws a constraint violation instead of
 * silently succeeding.
 */
export function append(
  db: Database,
  event: LedgerAppend.Input,
  expectedHead: LedgerAppend.ExpectedHead,
): LedgerAppend.Outcome {
  // Service-entry enforcement layer (the one owner of input validity).
  const parsed = LedgerAppend.Input.parse(event);
  const head = LedgerAppend.ExpectedHead.parse(expectedHead);

  const run = db.transaction((): LedgerAppend.Outcome => {
    if (head === 0) {
      // First append on a stream materializes its head row at 0 so the CAS
      // below stays a single UPDATE for every append. OR IGNORE makes this
      // a no-op (not a write) when the stream already exists.
      db.query("INSERT OR IGNORE INTO ledger_head (stream_id, head) VALUES (?, 0)").run(
        parsed.streamId,
      );
    }

    const cas = db
      .query("UPDATE ledger_head SET head = head + 1 WHERE stream_id = ? AND head = ?")
      .run(parsed.streamId, head);
    if (cas.changes !== 1) {
      const row = db
        .query("SELECT head FROM ledger_head WHERE stream_id = ?")
        .get(parsed.streamId) as { head: number } | null;
      return { kind: "cas_conflict", currentHead: row?.head ?? 0 };
    }

    const seq = head + 1;
    const tip = db
      .query("SELECT event_hash FROM ledger_event WHERE stream_id = ? ORDER BY seq DESC LIMIT 1")
      .get(parsed.streamId) as { event_hash: string } | null;
    const prevHash = tip?.event_hash ?? GENESIS_SEED;

    const data = JSON.stringify(parsed.data);
    const timeCreated = parsed.timeCreated ?? Date.now();
    const eventHash = computeLedgerEventHash({
      prevHash,
      streamId: parsed.streamId,
      seq,
      type: parsed.type,
      data,
      timeCreated,
    });

    db.query(
      `INSERT INTO ledger_event (stream_id, seq, type, data, prev_hash, event_hash, time_created)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(parsed.streamId, seq, parsed.type, data, prevHash, eventHash, timeCreated);

    return { kind: "appended", seq, eventHash };
  });

  return run.immediate();
}
