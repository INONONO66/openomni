import { Database } from "bun:sqlite";
import { L0Observation, type ObservationSink, type Storage } from "@openomni/protocol";
import { bootstrapStoreDatabase } from "../../src/storage";
import { CATALOG_SCHEMA } from "../../src/storage/schema-catalog";
import { SESSION_FILE_SCHEMA } from "../../src/storage/schema-session-file";
import { createActions } from "../../src/storage/sqlite-l0-actions";
import type { ObservationPublishFailure } from "../../src/storage/sqlite-l0-observation";
import { createSessions } from "../../src/storage/sqlite-l0-sessions";
import type { SessionWriteAdapter } from "../../src/services";

/** In-memory database on the fresh session-file schema. */
export function openLedgerDatabase(): Database {
  const db = new Database(":memory:");
  bootstrapStoreDatabase(db, SESSION_FILE_SCHEMA);
  return db;
}

/** In-memory database on the fresh catalog schema. */
export function openCatalogDatabase(): Database {
  const db = new Database(":memory:");
  bootstrapStoreDatabase(db, CATALOG_SCHEMA);
  return db;
}

/** Tests fail loudly on a swallowed publish failure instead of hiding it. */
function rethrowObservationFailure(failure: ObservationPublishFailure): never {
  throw failure.cause;
}

export interface L0Adapters {
  readonly sessions: SessionWriteAdapter;
  readonly actions: Storage.ActionSubAdapter;
}

/** Session-file adapters over one connection plus a capture of every committed action. */
export function observedL0Adapters(db: Database): {
  adapter: L0Adapters;
  observations: L0Observation.ActionCommitted[];
} {
  const observations: L0Observation.ActionCommitted[] = [];
  const transaction = <T>(operation: () => T): T => db.transaction(operation).immediate();
  const sink: ObservationSink = {
    publish(event, payload) {
      if (event.name === L0Observation.ActionCommittedEvent.name)
        observations.push(L0Observation.ActionCommitted.parse(payload));
    },
  };
  return {
    adapter: {
      sessions: createSessions(db, transaction, sink, rethrowObservationFailure),
      actions: createActions(db, transaction, sink, rethrowObservationFailure),
    },
    observations,
  };
}
