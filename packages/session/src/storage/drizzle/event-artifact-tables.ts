import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sessionTable } from "./core-tables";

export const artifactTable = sqliteTable(
  "artifact",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id")
      .notNull()
      .references(() => sessionTable.id, { onDelete: "cascade" }),
    meta: text("meta").notNull(),
    content: text("content").notNull(),
    time_created: integer("time_created").notNull(),
    time_updated: integer("time_updated").notNull(),
  },
  (t) => [index("idx_artifact_session").on(t.session_id)],
);

export const busEventTable = sqliteTable(
  "bus_event",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    session_id: text("session_id").references(() => sessionTable.id, { onDelete: "cascade" }),
    run_id: text("run_id"),
    event_type: text("event_type").notNull(),
    category: text("category").notNull(),
    data: text("data").notNull(),
    trace_id: text("trace_id").notNull(),
    duration_ms: integer("duration_ms"),
    time_created: integer("time_created").notNull(),
  },
  (t) => [
    index("idx_bus_event_session_time").on(t.session_id, t.time_created),
    index("idx_bus_event_run_time").on(t.run_id, t.time_created),
    index("idx_bus_event_type_session").on(t.event_type, t.session_id),
    index("idx_bus_event_category_session").on(t.category, t.session_id),
    index("idx_bus_event_trace").on(t.trace_id),
  ],
);
