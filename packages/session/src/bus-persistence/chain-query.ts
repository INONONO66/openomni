import { GENESIS_SEED, computeEventHash } from "./hash.js";
import type { ChainIntegrityResult } from "./query-contracts.js";
import { getDatabase } from "./database.js";
import type { HashChainRow } from "./query-rows.js";

export function verifyChainIntegrity(sessionId?: string): Promise<ChainIntegrityResult> {
  const db = getDatabase();
  const rows =
    sessionId === undefined
      ? (db
          .query(
            `SELECT id, event_type, data, trace_id, time_created, prev_hash, event_hash
             FROM bus_event WHERE session_id IS NULL ORDER BY id ASC`,
          )
          .all() as HashChainRow[])
      : (db
          .query(
            `SELECT id, event_type, data, trace_id, time_created, prev_hash, event_hash
             FROM bus_event WHERE session_id = ? ORDER BY id ASC`,
          )
          .all(sessionId) as HashChainRow[]);

  return Promise.resolve(walkChain(rows));
}

function walkChain(rows: HashChainRow[]): ChainIntegrityResult {
  if (rows.length === 0) return { valid: true, totalVerified: 0 };

  let expectedPrev = GENESIS_SEED;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as HashChainRow | undefined;
    if (!row) continue;

    // Events persisted before the hash chain migration have null hashes.
    // They cannot be verified so we skip them without breaking the chain.
    if (row.event_hash === null || row.prev_hash === null) {
      continue;
    }

    if (row.prev_hash !== expectedPrev) {
      return {
        valid: false,
        totalVerified: i,
        brokenAtId: row.id,
        brokenAtEventType: row.event_type,
      };
    }

    const recomputed = computeEventHash({
      prevHash: row.prev_hash,
      eventType: row.event_type,
      data: row.data,
      traceId: row.trace_id,
      timeCreated: row.time_created,
    });

    if (recomputed !== row.event_hash) {
      return {
        valid: false,
        totalVerified: i,
        brokenAtId: row.id,
        brokenAtEventType: row.event_type,
      };
    }

    expectedPrev = row.event_hash;
  }

  return { valid: true, totalVerified: rows.length };
}
