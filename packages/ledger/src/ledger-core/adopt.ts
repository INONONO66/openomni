import type { Database } from "bun:sqlite";
import { z } from "zod";
import { Ledger as LedgerTypes } from "@openomni/protocol";
import { GENESIS_SEED } from "./hash";
import { computeLedgerEventHash } from "./hash";

const HeadRevision = z.number().int().positive();

/**
 * Adopts a PRE-CUTOVER stream (#510 review fix F3): raw prepared statements
 * inside one sync `behavior "immediate"` transaction, same discipline as
 * {@link append}. The genesis fact lands at seq === `headRevision` and the
 * `ledger_head` row is set to `headRevision`, so the head↔revision equation
 * (fact seq N == projected revision N) holds for a projection row that
 * predates its owner stream — WITHOUT fabricating the row's per-transition
 * history. The genesis chains from GENESIS_SEED; tail verification treats a
 * missing predecessor below the oldest stored event as out of scope, so an
 * adopted stream verifies clean.
 *
 * Adoption is legal ONLY while the stream is empty (no events AND head 0 or
 * missing). A non-empty stream throws the typed `LedgerTypes.AdoptError` —
 * a stream with history must never receive a second genesis.
 */
export function adoptStream(
  db: Database,
  streamId: string,
  headRevision: number,
  genesis: LedgerTypes.AdoptGenesis,
): void {
  // Service-entry enforcement layer (the one owner of input validity).
  const parsed = LedgerTypes.AdoptGenesis.parse(genesis);
  const seq = HeadRevision.parse(headRevision);
  const stream = z.string().min(1).parse(streamId);

  db.transaction(() => {
    const head = db.query("SELECT head FROM ledger_head WHERE stream_id = ?").get(stream) as {
      head: number;
    } | null;
    const tip = db
      .query("SELECT seq FROM ledger_event WHERE stream_id = ? ORDER BY seq DESC LIMIT 1")
      .get(stream) as { seq: number } | null;
    if ((head !== null && head.head !== 0) || tip !== null) {
      throw new LedgerTypes.AdoptError({
        message: `stream ${stream} is not empty — adoption would fabricate a second genesis`,
        streamId: stream,
        currentHead: Math.max(head?.head ?? 0, tip?.seq ?? 0),
      });
    }

    const data = JSON.stringify(parsed.data);
    const timeCreated = parsed.timeCreated ?? Date.now();
    const eventHash = computeLedgerEventHash({
      prevHash: GENESIS_SEED,
      streamId: stream,
      seq,
      type: parsed.type,
      data,
      timeCreated,
    });
    db.query(
      `INSERT INTO ledger_event (stream_id, seq, type, data, prev_hash, event_hash, time_created)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(stream, seq, parsed.type, data, GENESIS_SEED, eventHash, timeCreated);
    // Defensive upsert: the empty check above proved that when a head row
    // exists at all it sits at 0, so overwriting it can never lose a head.
    db.query(
      `INSERT INTO ledger_head (stream_id, head) VALUES (?, ?)
       ON CONFLICT (stream_id) DO UPDATE SET head = excluded.head`,
    ).run(stream, seq);
  }).immediate();
}
