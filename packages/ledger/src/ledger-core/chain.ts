import type { Database } from "bun:sqlite";
import type { Ledger as LedgerTypes } from "@openomni/protocol";
import { GENESIS_SEED } from "../bus-persistence/hash";
import { computeLedgerEventHash } from "./hash";

/**
 * Boot verifies the chain TAIL only (#510): the newest TAIL_DEPTH events per
 * stream plus the head receipt. Full-chain verification is the #226 offline
 * restore drill, never a boot cost.
 */
const TAIL_DEPTH = 16;

interface EventRow {
  readonly seq: number;
  readonly type: string;
  readonly data: string;
  readonly prev_hash: string;
  readonly event_hash: string;
  readonly time_created: number;
}

/**
 * Walks the tail of every stream's hash chain and returns chain-break FACTS
 * (empty array = intact tails). This function only reports — it never
 * throws on a broken chain and never refuses boot; recording the fact and
 * raising the Governor incident is the boot caller's job at cutover.
 */
export function verifyTail(
  db: Database,
  options: { depth?: number; now?: number } = {},
): LedgerTypes.ChainBreak[] {
  const depth = options.depth ?? TAIL_DEPTH;
  const detectedAt = options.now ?? Date.now();
  const breaks: LedgerTypes.ChainBreak[] = [];

  const streams = db
    .query("SELECT stream_id FROM ledger_head UNION SELECT DISTINCT stream_id FROM ledger_event")
    .all() as { stream_id: string }[];

  for (const { stream_id: streamId } of streams) {
    verifyStreamTail({ db, streamId, depth, detectedAt, breaks });
  }
  return breaks;
}

function verifyStreamTail(input: {
  db: Database;
  streamId: string;
  depth: number;
  detectedAt: number;
  breaks: LedgerTypes.ChainBreak[];
}): void {
  const { db, streamId, depth, detectedAt, breaks } = input;

  // Newest first: rows[0] is the tail tip.
  const rows = db
    .query(
      `SELECT seq, type, data, prev_hash, event_hash, time_created
       FROM ledger_event WHERE stream_id = ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(streamId, depth) as EventRow[];

  // `.get()` returns null for an empty result on current bun:sqlite; the
  // `?? null` pins that shape locally so `headRow === null` below can never
  // meet an undefined from a future runtime change.
  const headRow = (db.query("SELECT head FROM ledger_head WHERE stream_id = ?").get(streamId) ??
    null) as { head: number } | null;
  const maxSeq = rows[0]?.seq ?? 0;
  if (headRow?.head !== maxSeq) {
    breaks.push({
      streamId,
      seq: maxSeq,
      code: "head_mismatch",
      expected: String(maxSeq),
      actual: headRow === null ? "missing" : String(headRow.head),
      detectedAt,
    });
  }

  const bySeq = new Map(rows.map((row) => [row.seq, row]));
  const oldestFetched = rows.at(-1);

  for (const row of rows) {
    const recomputed = computeLedgerEventHash({
      prevHash: row.prev_hash,
      streamId,
      seq: row.seq,
      type: row.type,
      data: row.data,
      timeCreated: row.time_created,
    });
    if (recomputed !== row.event_hash) {
      breaks.push({
        streamId,
        seq: row.seq,
        code: "hash_mismatch",
        expected: recomputed,
        actual: row.event_hash,
        detectedAt,
      });
    }

    if (row.seq === 1) {
      if (row.prev_hash !== GENESIS_SEED) {
        breaks.push({
          streamId,
          seq: 1,
          code: "link_mismatch",
          expected: GENESIS_SEED,
          actual: row.prev_hash,
          detectedAt,
        });
      }
      continue;
    }

    const previous = bySeq.get(row.seq - 1);
    if (previous === undefined) {
      // The oldest fetched row's predecessor lies beyond the tail window —
      // out of boot scope (#226 checks it). A missing predecessor anywhere
      // else is a hole in the tail itself.
      if (row !== oldestFetched) {
        breaks.push({
          streamId,
          seq: row.seq,
          code: "link_mismatch",
          expected: `event_hash of seq ${row.seq - 1}`,
          actual: "missing",
          detectedAt,
        });
      }
      continue;
    }
    if (row.prev_hash !== previous.event_hash) {
      breaks.push({
        streamId,
        seq: row.seq,
        code: "link_mismatch",
        expected: previous.event_hash,
        actual: row.prev_hash,
        detectedAt,
      });
    }
  }
}
