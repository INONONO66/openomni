import type {
  Alarm,
  Inbox,
  LedgerAction,
  LedgerSession,
  PolicyRow,
  Storage as ProtocolStorage,
} from "@openomni/protocol";
import { Storage } from "../storage/storage.js";

function required<K extends "sessions" | "actions" | "inbox" | "alarms" | "policies">(
  capability: K,
): NonNullable<Storage.Adapter[K]> {
  const value = Storage.get()[capability];
  if (value === undefined) throw new Error(`L0 storage capability is unavailable: ${capability}`);
  return value;
}

export const sessions = {
  create: (row: LedgerSession.Row): boolean => required("sessions").create(row),
  materialize: (input: LedgerSession.Materialize): LedgerSession.MaterializeResult | undefined =>
    required("sessions").materialize(input),
  get: (id: string): LedgerSession.Row | undefined => required("sessions").get(id),
  list: (): LedgerSession.Row[] => required("sessions").list(),
  acquireLease: (input: LedgerSession.AcquireLease): LedgerSession.LeaseResult | undefined =>
    required("sessions").acquireLease(input),
  renewLease: (input: LedgerSession.RenewLease): boolean => required("sessions").renewLease(input),
  commit: (input: LedgerSession.Commit): LedgerSession.CommitResult | undefined =>
    required("sessions").commit(input),
} satisfies ProtocolStorage.SessionLedgerSubAdapter;

export const actions = {
  append: (
    input: LedgerAction.Append,
    expectedRevision: number,
  ): LedgerAction.Receipt | undefined => required("actions").append(input, expectedRevision),
  tree: (sessionId: string): LedgerAction.Node[] => required("actions").tree(sessionId),
  revert: (
    input: LedgerAction.Append,
    expectedRevision: number,
  ): LedgerAction.Receipt | undefined => required("actions").append(input, expectedRevision),
};

export const inbox = {
  commit: (row: Inbox.Commit): Inbox.Row | undefined => required("inbox").commit(row),
  list: (sessionId: string, status?: Inbox.Status): Inbox.Row[] =>
    required("inbox").list(sessionId, status),
} satisfies ProtocolStorage.InboxSubAdapter;

export const alarms = {
  arm: (row: Alarm.Arm): Alarm.Row | undefined => required("alarms").arm(row),
  cancel: (id: string, updatedAt: number): Alarm.Row | undefined =>
    required("alarms").cancel(id, updatedAt),
  due: (at: number): Alarm.Row[] => required("alarms").due(at),
} satisfies ProtocolStorage.AlarmSubAdapter;

export const policies = {
  append: (row: PolicyRow.Row): boolean => required("policies").append(row),
  rows: (generation?: number): PolicyRow.Row[] => required("policies").rows(generation),
} satisfies ProtocolStorage.PolicyRowSubAdapter;
