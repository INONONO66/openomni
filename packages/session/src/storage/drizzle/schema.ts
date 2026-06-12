import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export const actorIdentityTable = sqliteTable(
  "actor_identity",
  {
    id: text("id").primaryKey(),
    data: text("data").notNull(),
    kind: text("kind").notNull(),
    trust_tier: text("trust_tier").notNull(),
    relationship: text("relationship").notNull(),
    time_created: integer("time_created").notNull(),
    time_updated: integer("time_updated").notNull(),
  },
  (t) => [index("idx_actor_identity_trust_tier").on(t.trust_tier)],
);

export const actorEndpointTable = sqliteTable(
  "actor_endpoint",
  {
    id: text("id").primaryKey(),
    actor_id: text("actor_id")
      .notNull()
      .references(() => actorIdentityTable.id, { onDelete: "cascade" }),
    data: text("data").notNull(),
    channel: text("channel").notNull(),
    workspace: text("workspace").notNull(),
    external_id: text("external_id").notNull(),
    time_created: integer("time_created").notNull(),
    time_updated: integer("time_updated").notNull(),
  },
  (t) => [
    index("idx_actor_endpoint_actor").on(t.actor_id),
    uniqueIndex("idx_actor_endpoint_lookup").on(t.channel, t.workspace, t.external_id),
  ],
);

export const blacklistTable = sqliteTable(
  "blacklist",
  {
    id: text("id").primaryKey(),
    data: text("data").notNull(),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    expires_at: integer("expires_at"),
    time_created: integer("time_created").notNull(),
    time_updated: integer("time_updated").notNull(),
  },
  (t) => [
    index("idx_blacklist_kind_value").on(t.kind, t.value),
    index("idx_blacklist_expires").on(t.expires_at),
  ],
);

export const channelGrantTable = sqliteTable(
  "channel_grant",
  {
    id: text("id").primaryKey(),
    data: text("data").notNull(),
    surface: text("surface").notNull(),
    workspace: text("workspace").notNull().default(""),
    channel: text("channel").notNull().default(""),
    kind: text("kind").notNull(),
    time_created: integer("time_created").notNull(),
    time_updated: integer("time_updated").notNull(),
  },
  (t) => [
    index("idx_channel_grant_lookup").on(t.surface, t.workspace, t.channel),
    index("idx_channel_grant_kind").on(t.kind),
  ],
);
