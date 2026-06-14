import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const appConnectorInstallationTable = sqliteTable(
  "app_connector_installation",
  {
    id: text("id").primaryKey(),
    connector_id: text("connector_id").notNull(),
    status: text("status").notNull(),
    data: text("data").notNull(),
    time_created: integer("time_created").notNull(),
    time_updated: integer("time_updated").notNull(),
  },
  (t) => [
    index("idx_app_connector_installation_connector").on(t.connector_id),
    index("idx_app_connector_installation_status").on(t.status),
  ],
);
