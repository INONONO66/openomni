import type { Database } from "bun:sqlite";
import { DecisionFact } from "@openomni/protocol";
import { z } from "zod";
import { computeDecisionFactHash } from "./l0-hash";
import { parseStoredJson, SqliteCount } from "./sqlite-json-data";

export const DECISION_FACT_MIGRATION = "0040_decision_fact/migration.sql";
/** The retired stream tables are named only here; every other module imports this owner. */
export const RETIRED_DECISION_TABLES = { facts: "ledger_event", heads: "ledger_head" } as const;

function retiredTablesPresent(db: Database): boolean {
  const present = z
    .object({ name: z.string() })
    .array()
    .parse(
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
        .all(RETIRED_DECISION_TABLES.facts, RETIRED_DECISION_TABLES.heads),
    );
  return present.length === 2;
}

export class DecisionFactMigrationError extends Error {
  readonly reason = "unknown_stream_class";

  constructor(readonly streamId: string) {
    super(`decision fact migration refused: ${streamId}`);
    this.name = "DecisionFactMigrationError";
  }
}

const HistoricalHead = z.object({
  key: z.string(),
  type: z.string(),
  data: z.string(),
  timeCreated: SqliteCount,
});

export function migrateDecisionFacts(db: Database): void {
  if (!retiredTablesPresent(db)) return;
  const streams = z
    .object({ stream_id: z.string() })
    .array()
    .parse(db.query(`SELECT DISTINCT stream_id FROM ${RETIRED_DECISION_TABLES.facts} ORDER BY stream_id`).all());
  for (const { stream_id: streamId } of streams) {
    if (
      !["route:", "route_correction:", "gateway_send:"].some((prefix) =>
        streamId.startsWith(prefix),
      )
    ) {
      throw new DecisionFactMigrationError(streamId);
    }
  }
  const heads = HistoricalHead.array().parse(
    db
      .query(
        `SELECT stream_id AS key, type, data, time_created AS timeCreated FROM ${RETIRED_DECISION_TABLES.facts} AS fact
     WHERE seq = (SELECT MAX(seq) FROM ${RETIRED_DECISION_TABLES.facts} WHERE stream_id = fact.stream_id) ORDER BY stream_id`,
      )
      .all(),
  );
  for (const head of heads) {
    DecisionFact.Record.parse({ ...head, data: parseStoredJson(head.data) });
    db.query(
      "INSERT INTO decision_fact (key, type, data, row_hash, time_created) VALUES (?, ?, ?, ?, ?)",
    ).run(head.key, head.type, head.data, computeDecisionFactHash(head), head.timeCreated);
  }
  db.run(`DROP TABLE ${RETIRED_DECISION_TABLES.facts}`);
  db.run(`DROP TABLE ${RETIRED_DECISION_TABLES.heads}`);
}
