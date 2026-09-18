import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { decisionFact } from "../../src/storage/decision-fact-schema";
import { openLedgerDatabase } from "../helpers/ledger";

let db: Database;

beforeEach(() => {
  db = openLedgerDatabase();
});

afterEach(() => {
  db.close();
});

/**
 * The drizzle DDL view (decision-fact-schema.ts, drizzle.config.ts casing
 * `snake_case`) must map onto the table the ordered migrations create —
 * script/check-ledger-schema-drift.ts owns full shape parity; this test keeps
 * the runtime column mapping honest against the applied 0040 DDL.
 */
test("decision-fact drizzle view reads and writes the migrated decision_fact table", () => {
  const client = drizzle({ client: db, schema: { decisionFact }, casing: "snake_case" });
  const row = {
    key: "route:drizzle",
    type: "route.decided",
    data: '{"value":"a|b"}',
    rowHash: "hash-1",
    timeCreated: 10,
  };
  client.insert(decisionFact).values(row).run();
  expect(client.select().from(decisionFact).all()).toEqual([row]);
  expect(
    db.query("SELECT key, type, data, row_hash, time_created FROM decision_fact").get(),
  ).toEqual({
    key: row.key,
    type: row.type,
    data: row.data,
    row_hash: row.rowHash,
    time_created: row.timeCreated,
  });
});
