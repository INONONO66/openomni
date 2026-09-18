import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Generator-only DDL view; runtime storage uses the ordered migrations. */
export const decisionFact = sqliteTable("decision_fact", {
  key: text().primaryKey(),
  type: text().notNull(),
  data: text().notNull(),
  rowHash: text().notNull(),
  timeCreated: integer().notNull(),
});
