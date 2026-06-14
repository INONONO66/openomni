import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionTable = sqliteTable("session", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
  time_created: integer("time_created").notNull(),
  time_updated: integer("time_updated").notNull(),
});

export const messageTable = sqliteTable(
  "message",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id")
      .notNull()
      .references(() => sessionTable.id, { onDelete: "cascade" }),
    data: text("data").notNull(),
    role: text("role"),
    status: text("status").notNull().default("completed"),
    time_created: integer("time_created").notNull(),
  },
  (t) => [index("idx_message_session_time").on(t.session_id, t.time_created, t.id)],
);

export const partTable = sqliteTable(
  "part",
  {
    id: text("id").primaryKey(),
    message_id: text("message_id")
      .notNull()
      .references(() => messageTable.id, { onDelete: "cascade" }),
    data: text("data").notNull(),
    type: text("type"),
    time_start: integer("time_start"),
  },
  (t) => [index("idx_part_message_id").on(t.message_id, t.id)],
);

export const surfaceKeyTable = sqliteTable(
  "surface_key",
  {
    key: text("key").primaryKey(),
    session_id: text("session_id")
      .notNull()
      .references(() => sessionTable.id, { onDelete: "cascade" }),
    time_created: integer("time_created").notNull(),
  },
  (t) => [index("idx_surface_key_session").on(t.session_id)],
);
