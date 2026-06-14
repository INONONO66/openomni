import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sessionTable } from "./core-tables";

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
    executor_kind: text("executor_kind"),
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

export const pendingAskTable = sqliteTable(
  "pending_ask",
  {
    id: text("id").primaryKey(),
    data: text("data").notNull(),
    status: text("status").notNull(),
    origin_session_id: text("origin_session_id")
      .notNull()
      .references(() => sessionTable.id, { onDelete: "cascade" }),
    endpoint_id: text("endpoint_id"),
    channel_id: text("channel_id"),
    external_message_id: text("external_message_id"),
    reply_to_message_id: text("reply_to_message_id"),
    thread_id: text("thread_id"),
    token_hash: text("token_hash"),
    external_conversation_id: text("external_conversation_id"),
    time_created: integer("time_created").notNull(),
    time_updated: integer("time_updated").notNull(),
  },
  (t) => [
    index("idx_pending_ask_status").on(t.status),
    index("idx_pending_ask_origin").on(t.origin_session_id, t.time_created),
    index("idx_pending_ask_correlation").on(
      t.endpoint_id,
      t.channel_id,
      t.external_message_id,
      t.reply_to_message_id,
      t.thread_id,
    ),
    index("idx_pending_ask_token_hash").on(t.token_hash),
    index("idx_pending_ask_external_conversation").on(t.external_conversation_id),
  ],
);

export const pendingInteractionTable = sqliteTable(
  "pending_interaction",
  {
    id: text("id").primaryKey(),
    worker_run_id: text("worker_run_id")
      .notNull()
      .references(() => workerRunStateTable.run_id, { onDelete: "cascade" }),
    session_id: text("session_id")
      .notNull()
      .references(() => sessionTable.id, { onDelete: "cascade" }),
    data: text("data").notNull(),
    status: text("status").notNull(),
    endpoint_id: text("endpoint_id").notNull(),
    channel_id: text("channel_id").notNull(),
    reply_to_message_id: text("reply_to_message_id"),
    thread_id: text("thread_id"),
    token_hash: text("token_hash"),
    external_conversation_id: text("external_conversation_id"),
    expires_at: integer("expires_at").notNull(),
    follow_up_until: integer("follow_up_until"),
    time_created: integer("time_created").notNull(),
    time_updated: integer("time_updated").notNull(),
  },
  (t) => [
    index("idx_pending_interaction_status").on(t.status),
    index("idx_pending_interaction_worker").on(t.worker_run_id, t.time_created),
    index("idx_pending_interaction_session").on(t.session_id, t.time_created),
    index("idx_pending_interaction_correlation").on(
      t.endpoint_id,
      t.channel_id,
      t.reply_to_message_id,
      t.thread_id,
    ),
    index("idx_pending_interaction_token_hash").on(t.token_hash),
    index("idx_pending_interaction_external_conversation").on(t.external_conversation_id),
  ],
);

export const workerGrantTable = sqliteTable(
  "worker_grant",
  {
    id: text("id").primaryKey(),
    worker_run_id: text("worker_run_id")
      .notNull()
      .references(() => workerRunStateTable.run_id, { onDelete: "cascade" }),
    data: text("data").notNull(),
    status: text("status").notNull(),
    version: integer("version").notNull(),
    time_created: integer("time_created").notNull(),
    time_updated: integer("time_updated").notNull(),
    expires_at: integer("expires_at"),
  },
  (t) => [
    index("idx_worker_grant_worker").on(t.worker_run_id),
    index("idx_worker_grant_status").on(t.status),
  ],
);
