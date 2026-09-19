import { Database } from "bun:sqlite";
import { L0Observation } from "@openomni/protocol";
import { createSqliteL0Adapters } from "../../src/storage/sqlite-l0-adapter";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";

/** In-memory database initialized through the production migration runner. */
export function openLedgerDatabase(): Database {
  const db = new Database(":memory:");
  initializeSqliteDatabase(db);
  return db;
}

/** L0 adapters over one connection plus a capture of every committed action. */
export function observedL0Adapters(db: Database): {
  adapter: ReturnType<typeof createSqliteL0Adapters>;
  observations: L0Observation.ActionCommitted[];
} {
  const observations: L0Observation.ActionCommitted[] = [];
  const adapter = createSqliteL0Adapters(db, (operation) => db.transaction(operation).immediate(), {
    publish(event, payload) {
      if (event.name === L0Observation.ActionCommittedEvent.name)
        observations.push(L0Observation.ActionCommitted.parse(payload));
    },
  });
  return { adapter, observations };
}
