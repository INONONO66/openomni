import type { Database } from "bun:sqlite";
import { Actor, type Storage as ProtocolStorage } from "@openomni/protocol";
import { sqliteJsonData, SqliteCountRow } from "./sqlite-json-data";

const IdentityRow = sqliteJsonData(Actor.Identity);
const EndpointRow = sqliteJsonData(Actor.Endpoint);

function workspaceKey(workspace: string | undefined): string {
  return workspace ?? "";
}

export function createSqliteActorRegistryAdapter(
  db: Database,
): ProtocolStorage.ActorRegistrySubAdapter {
  return {
    getIdentity(id) {
      return (
        IdentityRow.nullable().parse(
          db.query("SELECT data FROM actor_identity WHERE id = ?").get(id),
        ) ?? undefined
      );
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
    removeIdentity(id) {
      return db.query("DELETE FROM actor_identity WHERE id = ?").run(id).changes > 0;
    },
    getEndpoint(id) {
      return (
        EndpointRow.nullable().parse(
          db.query("SELECT data FROM actor_endpoint WHERE id = ?").get(id),
        ) ?? undefined
      );
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
      const row = EndpointRow.nullable().parse(
        db
          .query(
            `SELECT data FROM actor_endpoint
             WHERE channel = ? AND workspace = ? AND external_id = ?`,
          )
          .get(channel, workspaceKey(workspace), externalId),
      );
      return row ?? undefined;
    },
    listEndpoints(actorId, workspace) {
      return EndpointRow.array().parse(
        db
          .query(
            `SELECT data FROM actor_endpoint
         WHERE (? IS NULL OR actor_id = ?) AND (? IS NULL OR workspace = ?)
         ORDER BY time_created ASC, id ASC`,
          )
          .all(actorId ?? null, actorId ?? null, workspace ?? null, workspaceKey(workspace)),
      );
    },
    removeEndpoint(id) {
      return db.query("DELETE FROM actor_endpoint WHERE id = ?").run(id).changes > 0;
    },
    countProvisionalSince(channel, workspace, since) {
      const row = SqliteCountRow.parse(
        db
          .query(
            `SELECT COUNT(*) AS count
           FROM actor_identity i
           JOIN actor_endpoint e ON e.actor_id = i.id
           WHERE e.channel = ? AND e.workspace = ?
             AND json_extract(i.data, '$.standing') = 'provisional'
             AND i.time_created >= ?`,
          )
          .get(channel, workspaceKey(workspace), since),
      );
      return row.count;
    },
  };
}
