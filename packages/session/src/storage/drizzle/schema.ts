import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

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

export const workerRunStateTable = sqliteTable(
  "worker_run_state",
  {
    run_id: text("run_id").primaryKey(),
    session_id: text("session_id")
      .notNull()
      .references(() => sessionTable.id, { onDelete: "cascade" }),
    parent_session_id: text("parent_session_id"),
    agent_name: text("agent_name").notNull(),
    status: text("status").notNull(),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    resume_count: integer("resume_count").notNull().default(0),
    assigned_step_id: text("assigned_step_id"),
    error: text("error"),
    time_created: integer("time_created").notNull(),
    time_updated: integer("time_updated").notNull(),
  },
  (t) => [index("idx_worker_run_state_session_time").on(t.session_id, t.time_created)],
);
