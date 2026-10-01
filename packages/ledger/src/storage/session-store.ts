import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ObservationSink, Storage as ProtocolStorage } from "@openomni/protocol";
import type { SessionWriteAdapter } from "../services";
import { SESSION_FILE_SCHEMA } from "./schema-session-file.js";
import { createSqliteDecisionFacts } from "./sqlite-decision-facts";
import { createActions } from "./sqlite-l0-actions.js";
import { createSessions } from "./sqlite-l0-sessions.js";

// busy_timeout comes FIRST: the pragma is connection-local (it never touches
// the database file), so applying it before any file-touching statement makes
// a concurrent multi-process open wait for a busy writer instead of failing
// its first read/write instantly with SQLITE_BUSY (W5.2 review F9).
const OPEN_PRAGMAS = [
  "PRAGMA busy_timeout = 5000",
  "PRAGMA journal_mode = WAL",
  // Decision-class writes survive power loss (#510 D1): committed appends are
  // durable, which is what "no record, no action" means.
  "PRAGMA synchronous = FULL",
  "PRAGMA foreign_keys = ON",
] as const;

export const SILENT_OBSERVATION_SINK: ObservationSink = { publish: () => undefined };

/** Applies the busy-first open pragmas, then bootstraps the fresh schema in
 * one immediate transaction so concurrent openers serialize on the DDL. */
export function bootstrapStoreDatabase(db: Database, schema: readonly string[]): void {
  for (const pragma of OPEN_PRAGMAS) {
    const statement = db.prepare(pragma);
    try {
      statement.all();
    } finally {
      statement.finalize();
    }
  }
  db.transaction(() => {
    for (const statement of schema) db.run(statement);
  }).immediate();
}

export function openStoreDatabase(path: string, schema: readonly string[]): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  let bootstrapped = false;
  try {
    bootstrapStoreDatabase(db, schema);
    bootstrapped = true;
  } finally {
    if (!bootstrapped) db.close();
  }
  return db;
}

/** Folds the WAL back into the main file so a cold start reads a clean
 * baseline, then closes the connection. */
function closeStoreDatabase(db: Database): void {
  db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  db.close();
}

/** Shared transaction and idempotent close behavior for catalog and session files. */
export class StoreHandle {
  readonly observationSink: ObservationSink;
  // Every transaction caller is a write unit: take the write lock up front
  // (BEGIN IMMEDIATE) instead of upgrading mid-transaction.
  readonly transaction = <T>(operation: () => T): T => this.db.transaction(operation).immediate();
  protected readonly db: Database;
  private closed = false;

  constructor(db: Database, observationSink: ObservationSink) {
    this.db = db;
    this.observationSink = observationSink;
  }

  /** Idempotent — explicit teardown and scope finalizers may both close. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeStoreDatabase(this.db);
  }
}

/**
 * Handle-scoped per-session ledger file (W5.2 review F1): one open handle per
 * `<sessionsDir>/<sessionId>.sqlite`, no process-global registration. Owns the
 * session row, the action hash chain and decision facts of exactly one session.
 */
export class SessionStore extends StoreHandle {
  readonly sessions: SessionWriteAdapter;
  readonly actions: ProtocolStorage.ActionSubAdapter;
  readonly decisionFacts: ProtocolStorage.DecisionFactSubAdapter;
  constructor(db: Database, observationSink: ObservationSink) {
    super(db, observationSink);
    this.sessions = createSessions(db, this.transaction, observationSink);
    this.actions = createActions(db, this.transaction, observationSink);
    this.decisionFacts = createSqliteDecisionFacts(db);
  }
}

export function openSessionStore(
  path: string,
  observationSink: ObservationSink = SILENT_OBSERVATION_SINK,
): SessionStore {
  return new SessionStore(openStoreDatabase(path, SESSION_FILE_SCHEMA), observationSink);
}
