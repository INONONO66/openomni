import type { Database } from "bun:sqlite";
import { Actor, type Storage as ProtocolStorage } from "@openomni/protocol";
import { SqliteJsonDataRowSchema, SqliteJsonDataRowsSchema } from "./sqlite-json-data";

function workspaceKey(workspace: string | undefined): string {
  return workspace ?? "";
}

export function createSqliteActorRegistryAdapter(
  db: Database,
): ProtocolStorage.ActorRegistrySubAdapter {
  return {
    getIdentity(id) {
      const row = SqliteJsonDataRowSchema.nullable().parse(
        db.query("SELECT data FROM actor_identity WHERE id = ?").get(id),
      );
      return row ? Actor.Identity.parse(JSON.parse(row.data)) : undefined;
    },
    setIdentity(identity) {
      const now = Date.now();
      db.query(
        `INSERT INTO actor_identity (
           id, data, kind, trust_tier, time_created, time_updated
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data = excluded.data,
           kind = excluded.kind,
           trust_tier = excluded.trust_tier,
           time_updated = excluded.time_updated`,
      ).run(
        identity.id,
        JSON.stringify(identity),
        identity.kind,
        identity.trustTier,
        identity.createdAt ?? now,
        identity.updatedAt ?? now,
      );
    },
    listIdentities() {
      const rows = SqliteJsonDataRowsSchema.parse(
        db.query("SELECT data FROM actor_identity ORDER BY time_created ASC, id ASC").all(),
      );
      return rows.map((row) => Actor.Identity.parse(JSON.parse(row.data)));
    },
    removeIdentity(id) {
      return db.query("DELETE FROM actor_identity WHERE id = ?").run(id).changes > 0;
    },
    getEndpoint(id) {
      const row = SqliteJsonDataRowSchema.nullable().parse(
        db.query("SELECT data FROM actor_endpoint WHERE id = ?").get(id),
      );
      return row ? Actor.Endpoint.parse(JSON.parse(row.data)) : undefined;
    },
    setEndpoint(endpoint) {
      const now = Date.now();
      db.query(
        `INSERT INTO actor_endpoint (
           id, actor_id, data, channel, workspace, external_id, time_created, time_updated
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           actor_id = excluded.actor_id,
           data = excluded.data,
           channel = excluded.channel,
           workspace = excluded.workspace,
           external_id = excluded.external_id,
           time_updated = excluded.time_updated`,
      ).run(
        endpoint.id,
        endpoint.actorId,
        JSON.stringify(endpoint),
        endpoint.channel,
        workspaceKey(endpoint.workspace),
        endpoint.externalId,
        endpoint.createdAt ?? now,
        endpoint.updatedAt ?? now,
      );
    },
    findEndpoint(channel, externalId, workspace) {
      const row = SqliteJsonDataRowSchema.nullable().parse(
        db
          .query(
            `SELECT data FROM actor_endpoint
             WHERE channel = ? AND workspace = ? AND external_id = ?`,
          )
          .get(channel, workspaceKey(workspace), externalId),
      );
      return row ? Actor.Endpoint.parse(JSON.parse(row.data)) : undefined;
    },
    listEndpoints(actorId, workspace) {
      const workspaceFilter = workspaceKey(workspace);
      const rows = SqliteJsonDataRowsSchema.parse(
        actorId === undefined && workspace === undefined
          ? db.query("SELECT data FROM actor_endpoint ORDER BY time_created ASC, id ASC").all()
          : actorId === undefined
            ? db
                .query(
                  `SELECT data FROM actor_endpoint
                   WHERE workspace = ?
                   ORDER BY time_created ASC, id ASC`,
                )
                .all(workspaceFilter)
            : workspace === undefined
              ? db
                  .query(
                    `SELECT data FROM actor_endpoint
                     WHERE actor_id = ?
                     ORDER BY time_created ASC, id ASC`,
                  )
                  .all(actorId)
              : db
                  .query(
                    `SELECT data FROM actor_endpoint
                     WHERE actor_id = ? AND workspace = ?
                     ORDER BY time_created ASC, id ASC`,
                  )
                  .all(actorId, workspaceFilter),
      );
      return rows.map((row) => Actor.Endpoint.parse(JSON.parse(row.data)));
    },
    removeEndpoint(id) {
      return db.query("DELETE FROM actor_endpoint WHERE id = ?").run(id).changes > 0;
    },
  };
}
