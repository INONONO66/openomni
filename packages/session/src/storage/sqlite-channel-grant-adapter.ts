import type { Database } from "bun:sqlite";
import { Actor, type Storage as ProtocolStorage } from "@openomni/protocol";
import { z } from "zod";

const DataRow = z.object({ data: z.string() });
const DataRows = z.array(DataRow);

export function createSqliteChannelGrantAdapter(
  db: Database,
): ProtocolStorage.ChannelGrantSubAdapter {
  return {
    get(id) {
      const row = DataRow.nullable().parse(
        db.query("SELECT data FROM channel_grant WHERE id = ?").get(id),
      );
      return row ? Actor.ChannelGrant.parse(JSON.parse(row.data)) : undefined;
    },
    set(grant) {
      const now = Date.now();
      db.query(
        `INSERT INTO channel_grant (
           id, data, surface, workspace, channel, kind, time_created, time_updated
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data = excluded.data,
           surface = excluded.surface,
           workspace = excluded.workspace,
           channel = excluded.channel,
           kind = excluded.kind,
           time_updated = excluded.time_updated`,
      ).run(
        grant.id,
        JSON.stringify(grant),
        grant.surface,
        grant.workspace ?? "",
        grant.channel ?? "",
        grant.kind,
        grant.createdAt ?? now,
        grant.updatedAt ?? now,
      );
    },
    list() {
      const rows = DataRows.parse(
        db.query("SELECT data FROM channel_grant ORDER BY time_created ASC, id ASC").all(),
      );
      return rows.map((row) => Actor.ChannelGrant.parse(JSON.parse(row.data)));
    },
    remove(id) {
      return db.query("DELETE FROM channel_grant WHERE id = ?").run(id).changes > 0;
    },
  };
}
