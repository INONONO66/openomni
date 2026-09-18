import type { Database } from "bun:sqlite";
import { DecisionFact, type Storage } from "@openomni/protocol";
import { z } from "zod";
import { computeDecisionFactHash } from "./l0-hash";
import { parseStoredJson } from "./sqlite-json-data";

const Row = z
  .object({
    key: z.string(),
    type: z.string(),
    data: z.string(),
    row_hash: z.string(),
    time_created: z.number(),
  })
  .transform((row) =>
    DecisionFact.Recorded.parse({
      key: row.key,
      type: row.type,
      data: parseStoredJson(row.data),
      rowHash: row.row_hash,
      timeCreated: row.time_created,
    }),
  );

export function createSqliteDecisionFacts(db: Database): Storage.DecisionFactSubAdapter {
  function head(key: string): DecisionFact.Recorded | undefined {
    const row = db.query("SELECT * FROM decision_fact WHERE key = ?").get(key);
    return row === null ? undefined : Row.parse(row);
  }

  return {
    head,
    record(input) {
      const parsed = DecisionFact.Record.parse(input);
      const data = JSON.stringify(parsed.data);
      const rowHash = computeDecisionFactHash({ ...parsed, data });
      return db
        .transaction((): DecisionFact.Outcome => {
          const result = db
            .query(
              "INSERT OR IGNORE INTO decision_fact (key, type, data, row_hash, time_created) VALUES (?, ?, ?, ?, ?)",
            )
            .run(parsed.key, parsed.type, data, rowHash, parsed.timeCreated);
          const fact = Row.parse(
            db.query("SELECT * FROM decision_fact WHERE key = ?").get(parsed.key),
          );
          return { kind: result.changes === 1 ? "recorded" : "exists", fact };
        })
        .immediate();
    },
  };
}
