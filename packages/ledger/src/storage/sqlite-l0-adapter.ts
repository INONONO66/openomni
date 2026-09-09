import type { Database } from "bun:sqlite";
import type { ObservationSink, Storage as ProtocolStorage } from "@openomni/protocol";
import { createSessions } from "./sqlite-l0-sessions.js";
import { createActions } from "./sqlite-l0-actions.js";
import { createInbox } from "./sqlite-l0-inbox.js";
import { createAlarms } from "./sqlite-l0-alarms.js";
import { createPolicies } from "./sqlite-l0-policies.js";

interface SqliteL0Adapters {
  sessions: ProtocolStorage.SessionLedgerSubAdapter;
  actions: ProtocolStorage.ActionSubAdapter;
  inbox: ProtocolStorage.InboxSubAdapter;
  alarms: ProtocolStorage.AlarmSubAdapter;
  policies: ProtocolStorage.PolicyRowSubAdapter;
}

export function createSqliteL0Adapters(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
): SqliteL0Adapters {
  const sessions = createSessions(db, transaction, observationSink);
  const actions = createActions(db, transaction, observationSink);
  const inbox = createInbox(db, transaction, observationSink);
  return {
    sessions,
    actions,
    inbox,
    alarms: createAlarms(db, transaction, observationSink),
    policies: createPolicies(db, transaction),
  };
}
