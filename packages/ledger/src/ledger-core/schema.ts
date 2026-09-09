import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Drizzle's generation/test view of the ledger tables, using snake_case columns.
 * Runtime queries use prepared SQL; the immutable ordered migrations own applied DDL.
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
