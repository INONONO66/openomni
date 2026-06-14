import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
