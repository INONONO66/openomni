import {
  Alarm,
  Inbox,
  LedgerAction,
  LedgerSession,
  PolicyRow,
  type Storage as ProtocolStorage,
} from "@openomni/protocol";
import { alarmAction, inboxAction } from "../../src/storage/l0-action-builders.js";

export interface MemoryL0Adapter {
  transaction<T>(operation: () => T): T;
  sessions: ProtocolStorage.SessionLedgerSubAdapter;
  actions: ProtocolStorage.ActionSubAdapter;
  inbox: ProtocolStorage.InboxSubAdapter;
  alarms: ProtocolStorage.AlarmSubAdapter;
  policies: ProtocolStorage.PolicyRowSubAdapter;
}

export function createMemoryL0Adapter(): MemoryL0Adapter {
  const sessions = new Map<string, LedgerSession.Row>();
  const actions = new Map<string, LedgerAction.Node>();
  const inboxRows = new Map<string, Inbox.Row>();
  const alarmRows = new Map<string, Alarm.Row>();
  const policyRows = new Map<string, PolicyRow.Row>();

  return {
    transaction: (operation) => operation(),
    sessions: {
      create(row) {
        const parsed = LedgerSession.Row.parse(row);
        if (sessions.has(parsed.id)) return false;
        sessions.set(parsed.id, parsed);
        return true;
      },
      get: (id) => sessions.get(id),
      list: () => [...sessions.values()].sort((left, right) => left.id.localeCompare(right.id)),
    },
    actions: {
      append(input, expectedRevision) {
        const parsed = LedgerAction.Append.parse(input);
        const session = sessions.get(parsed.sessionId);
        if (session === undefined || session.revision !== expectedRevision) return undefined;
        if (actions.has(parsed.id)) return undefined;
        if (!hasValidParent(actions, parsed)) return undefined;
        const action = LedgerAction.Node.parse({ ...parsed, ordinal: expectedRevision + 1 });
        actions.set(action.id, action);
        sessions.set(session.id, { ...session, revision: expectedRevision + 1 });
        return { action, revision: expectedRevision + 1 };
      },
      tree: (sessionId) =>
        [...actions.values()]
          .filter((action) => action.sessionId === sessionId)
          .sort((left, right) => left.ordinal - right.ordinal),
    },
    inbox: {
      commit(row) {
        const parsed = Inbox.Commit.parse(row);
        if (!sessions.has(parsed.sessionId) || inboxRows.has(parsed.id) || actions.has(parsed.id)) {
          return undefined;
        }
        const action = appendInboxAction(actions, sessions, parsed);
        if (action === undefined) return undefined;
        const committed = Inbox.Row.parse({
          ...parsed,
          status: "pending",
          claimedBy: null,
          claimedAt: null,
          ordinal: nextInboxOrdinal(inboxRows, parsed.sessionId),
        });
        inboxRows.set(committed.id, committed);
        return committed;
      },
      list(sessionId, status) {
        return [...inboxRows.values()]
          .filter((row) => row.sessionId === sessionId && (status === undefined || row.status === status))
          .sort(compareInboxRows);
      },
      claim(sessionId, claimant, claimedAt) {
        const claimed: Inbox.Row[] = [];
        for (const row of [...inboxRows.values()].filter(
          (candidate) => candidate.sessionId === sessionId && candidate.status === "pending",
        ).sort(compareInboxRows)) {
          const next = Inbox.Row.parse({
            ...row,
            status: "claimed",
            claimedBy: claimant,
            claimedAt,
          });
          inboxRows.set(next.id, next);
          claimed.push(next);
        }
        return claimed;
      },
    },
    alarms: {
      arm(input) {
        const parsed = Alarm.Arm.parse(input);
        const session = sessions.get(parsed.sessionId);
        if (session === undefined || alarmRows.has(parsed.id) || actions.has(parsed.id)) return undefined;
        const action = alarmAction(parsed, session.revision + 1);
        const row = Alarm.Row.parse({
          ...parsed,
          status: "armed",
          createdAt: parsed.fireAt,
          updatedAt: parsed.fireAt,
        });
        actions.set(action.id, action);
        sessions.set(session.id, { ...session, revision: session.revision + 1 });
        alarmRows.set(row.id, row);
        return row;
      },
      cancel(id, updatedAt) {
        const row = alarmRows.get(id);
        if (row === undefined || row.status !== "armed") return undefined;
        const cancelled = Alarm.Row.parse({ ...row, status: "cancelled", updatedAt });
        alarmRows.set(id, cancelled);
        return cancelled;
      },
      due(at) {
        return [...alarmRows.values()]
          .filter((row) => row.status === "armed" && row.fireAt <= at)
          .sort((left, right) => left.fireAt - right.fireAt || left.id.localeCompare(right.id));
      },
    },
    policies: {
      append(row) {
        const parsed = PolicyRow.Row.parse(row);
        const key = policyKey(parsed);
        if (policyRows.has(key)) return false;
        policyRows.set(key, parsed);
        return true;
      },
      rows(generation) {
        return [...policyRows.values()]
          .filter((row) => generation === undefined || row.generation === generation)
          .sort(comparePolicyRows);
      },
    },
  };
}

function hasValidParent(
  actions: ReadonlyMap<string, LedgerAction.Node>,
  input: LedgerAction.Append,
): boolean {
  if (input.parentId === null) return true;
  return actions.get(input.parentId)?.sessionId === input.sessionId;
}

function appendInboxAction(
  actions: Map<string, LedgerAction.Node>,
  sessions: Map<string, LedgerSession.Row>,
  row: Inbox.Commit,
): LedgerAction.Node | undefined {
  const session = sessions.get(row.sessionId);
  if (session === undefined) return undefined;
  const action = inboxAction(row, session.revision + 1);
  actions.set(action.id, action);
  sessions.set(session.id, { ...session, revision: session.revision + 1 });
  return action;
}

function nextInboxOrdinal(rows: ReadonlyMap<string, Inbox.Row>, sessionId: string): number {
  let ordinal = 0;
  for (const row of rows.values()) {
    if (row.sessionId === sessionId) ordinal = Math.max(ordinal, row.ordinal);
  }
  return ordinal + 1;
}

function compareInboxRows(left: Inbox.Row, right: Inbox.Row): number {
  return left.ordinal - right.ordinal;
}

function policyKey(row: PolicyRow.Row): string {
  return `${row.generation}\u0000${row.name}\u0000${row.kind}\u0000${row.phase}`;
}

function comparePolicyRows(left: PolicyRow.Row, right: PolicyRow.Row): number {
  return (
    left.generation - right.generation ||
    right.priority - left.priority ||
    left.name.localeCompare(right.name) ||
    left.kind.localeCompare(right.kind) ||
    left.phase.localeCompare(right.phase)
  );
}
