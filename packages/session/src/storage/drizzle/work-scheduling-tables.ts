import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workItemTable = sqliteTable(
  "work_item",
  {
    hash: text("hash").primaryKey(),
    data: text("data").notNull(),
    status: text("status").notNull(),
    assignee_id: text("assignee_id"),
    session_id: text("session_id"),
    parent_hash: text("parent_hash"),
    source_channel: text("source_channel").notNull(),
    time_created: integer("time_created").notNull(),
    time_updated: integer("time_updated").notNull(),
  },
  (t) => [
    index("idx_work_item_status").on(t.status),
    index("idx_work_item_assignee").on(t.assignee_id),
    index("idx_work_item_session").on(t.session_id),
    index("idx_work_item_parent").on(t.parent_hash),
  ],
);

export const cronJobTable = sqliteTable("cron_job", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
  time_created: integer("time_created").notNull(),
  time_updated: integer("time_updated").notNull(),
});
