import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * DDL source of truth for the #510 clean-ledger baseline. Drizzle is used
 * here for definition (and drizzle-kit generation) ONLY — every runtime
 * statement in append.ts / chain.ts stays a raw prepared statement
 * (decision-class rule, docs/clean-room-blueprint.md "Storage decisions").
 *
 * Column names derive from the property names via the `snake_case` casing
 * pinned in drizzle.config.ts and db.ts. The applied DDL is the hand-written
 * migration/0013_ledger/migration.sql run by the existing BEGIN IMMEDIATE
 * runner; if drizzle-kit output ever differs, the hand SQL wins.
 */

/** One hash-chained decision-class fact per (stream_id, seq). */
export const ledgerEvent = sqliteTable(
  "ledger_event",
  {
    streamId: text().notNull(),
    seq: integer().notNull(),
    type: text().notNull(),
    /** JSON text; exactly the bytes fed to the event hash. */
    data: text().notNull(),
    prevHash: text().notNull(),
    eventHash: text().notNull(),
    timeCreated: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.streamId, table.seq] })],
);

/** Serialized CAS head per owner stream: head = last appended seq. */
export const ledgerHead = sqliteTable("ledger_head", {
  streamId: text().primaryKey(),
  head: integer().notNull(),
});
