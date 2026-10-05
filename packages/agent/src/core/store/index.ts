// Journal namespace surface (#1247): the append-only store and its ports.
export { openCatalogStore, CATALOG_SCHEMA } from "./catalog";
export { bootstrapStoreDatabase, openSessionStore, readSessionFileSchemaVersion, SESSION_FILE_SCHEMA_VERSION } from "./session-file";
export type { ObservationFailurePort, ObservationPublishFailure } from "./storage/sqlite-l0-observation";
export { createDecisionFactPort } from "./decision";
export * as SessionHandleStore from "./fence";
export { createSurfaceKeyStore } from "./surface-key";
export { CommitRefused, CorruptRecord, type LedgerError } from "./errors";
export type { AdoptReceipt, CommitReceipt, LedgerHandles } from "./services";
export { requireSubAdapter, withStoreTimestamps } from "./storage/timestamped-store";
export { StoredEndpoint, StoredIdentity } from "./storage/actor-schema";
