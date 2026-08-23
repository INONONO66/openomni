import type { Database } from "bun:sqlite";
import type { Storage } from "./storage";

/**
 * #547 C3: append-only transcript fact rows. The surface is append + read
 * ONLY by design — a recorded fact is immutable, so no update or delete
 * exists here; every later lifecycle step is a NEW `part.advanced` fact.
 *
 * `seq` is allocated per session stream as MAX(seq)+1, which is race-free
 * because the store calls append inside the adapter's BEGIN IMMEDIATE
 * transaction (one writer holds the lock for read-allocate-insert). The
 * composite PK (session_id, seq) is the explosive backstop for any write
 * that bypasses that discipline.
 */
export function createSqliteTranscriptFactAdapter(
  db: Database,
): NonNullable<Storage.Adapter["transcriptFact"]> {
  return {
    append: (row): number => {
      const next = db
        .query("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM transcript_fact WHERE session_id = ?")
        .get(row.sessionID) as { seq: number };
      db.query(
        `INSERT INTO transcript_fact (session_id, seq, message_id, attempt_id, type, data, time_created)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.sessionID,
        next.seq,
        row.messageID,
        row.attemptID,
        row.type,
        row.data,
        row.timeCreated,
      );
      return next.seq;
    },

    list: (sessionID): Storage.TranscriptFactRow[] =>
      db
        .query(
          `SELECT session_id AS sessionID, seq, message_id AS messageID,
                  attempt_id AS attemptID, type, data, time_created AS timeCreated
           FROM transcript_fact WHERE session_id = ? ORDER BY seq ASC`,
        )
        .all(sessionID) as Storage.TranscriptFactRow[],

    listByAttempt: (sessionID, attemptID): Storage.TranscriptFactRow[] =>
      db
        .query(
          `SELECT session_id AS sessionID, seq, message_id AS messageID,
                  attempt_id AS attemptID, type, data, time_created AS timeCreated
           FROM transcript_fact
           WHERE session_id = ? AND attempt_id = ? ORDER BY seq ASC`,
        )
        .all(sessionID, attemptID) as Storage.TranscriptFactRow[],

    // #562 F7: continuity check for the record path's fold-state cache — a
    // covering-index count (idx_transcript_fact_attempt), no row payloads.
    countByAttempt: (sessionID, attemptID): number => {
      const row = db
        .query(
          `SELECT COUNT(*) AS count FROM transcript_fact
           WHERE session_id = ? AND attempt_id = ?`,
        )
        .get(sessionID, attemptID) as { count: number };
      return row.count;
    },
  };
}
