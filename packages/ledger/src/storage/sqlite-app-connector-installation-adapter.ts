import { AppConnector, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";
import { SqliteJsonDataRowSchema, SqliteJsonDataRowsSchema } from "./sqlite-json-data";

export function createSqliteAppConnectorInstallationAdapter(
  db: Database,
): ProtocolStorage.AppConnectorInstallationSubAdapter {
  return {
    get(id) {
      const row = SqliteJsonDataRowSchema.nullable().parse(
        db.query("SELECT data FROM app_connector_installation WHERE id = ?").get(id),
      );
      return row ? AppConnector.Installation.parse(JSON.parse(row.data)) : undefined;
    },
    set(installation) {
      db.query(
        `INSERT INTO app_connector_installation (
           id, connector_id, status, data, time_created, time_updated
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           connector_id = excluded.connector_id,
           status = excluded.status,
           data = excluded.data,
           time_created = excluded.time_created,
           time_updated = excluded.time_updated`,
      ).run(
        installation.id,
        installation.connectorId,
        installation.status,
        JSON.stringify(installation),
        installation.createdAt,
        installation.updatedAt,
      );
    },
    list() {
      const rows = SqliteJsonDataRowsSchema.parse(
        db
          .query("SELECT data FROM app_connector_installation ORDER BY time_created ASC, id ASC")
          .all(),
      );
      return rows.map((row) => AppConnector.Installation.parse(JSON.parse(row.data)));
    },
    remove(id) {
      return db.query("DELETE FROM app_connector_installation WHERE id = ?").run(id).changes > 0;
    },
  };
}
